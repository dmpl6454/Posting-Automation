import { Worker, type Job } from "bullmq";
import { prisma, type Sentiment } from "@postautomation/db";
import {
  QUEUE_NAMES,
  type SentimentAnalysisJobData,
  type SentimentMentionInput,
  createRedisConnection,
} from "@postautomation/queue";

export type SentimentResult = {
  mentionId: string;
  sentiment: Sentiment;
  score: number;
  error?: true;
};

/**
 * Dependency-injected deps so this can be unit-tested without mocking module
 * resolution for @postautomation/ai / @postautomation/db.
 */
export type ScoreSentimentDeps = {
  generateContentWithFallback: (prompt: string) => Promise<string>;
  updateMention: (mentionId: string, sentiment: Sentiment, score: number) => Promise<unknown>;
  /** Ordered list of providers the fallback chain will attempt, for the all-failed error log. */
  providersAttempted: string[];
};

/**
 * SL-04 (light scope): score a single mention's sentiment using the shared
 * provider-chain helper (withTextProviderFallback from @postautomation/ai)
 * instead of a single hardcoded provider. No provider is chosen, so the chain
 * is the shared default [deepseek → openai → anthropic] (DeepSeek first —
 * owner decision 2026-10-09; it started with anthropic before).
 * Previously a lone `provider: "anthropic"` call meant ANY failure (missing
 * key, 401, rate limit, malformed JSON) fell straight to the generic catch
 * block, which silently wrote NEUTRAL/0 indistinguishably from a real
 * AI-determined neutral verdict. The fallback chain means anthropic's
 * absence/failure alone no longer immediately zeroes out every mention's
 * sentiment.
 *
 * When EVERY provider in the chain fails, we still persist NEUTRAL/0 (no
 * schema change in this light scope — see CLAUDE.md SL-04) but emit a clearly
 * distinct, greppable log line naming the providers attempted, so the
 * degraded state is visible in worker logs instead of looking identical to a
 * genuine neutral score.
 */
export async function scoreMentionSentiment(
  mentionId: string,
  content: string,
  deps: ScoreSentimentDeps,
): Promise<SentimentResult> {
  const prompt = `Analyze the sentiment of this text and respond with ONLY a JSON object (no markdown, no explanation):
{"sentiment": "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "MIXED", "score": <number from -1.0 to 1.0>}

Text: "${content.slice(0, 500)}"`;

  try {
    const result = await deps.generateContentWithFallback(prompt);

    // Parse the JSON response
    const jsonMatch = result.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const sentiment: Sentiment = ["POSITIVE", "NEGATIVE", "NEUTRAL", "MIXED"].includes(parsed.sentiment)
        ? parsed.sentiment
        : "NEUTRAL";
      const score = typeof parsed.score === "number"
        ? Math.max(-1, Math.min(1, parsed.score))
        : 0;

      await deps.updateMention(mentionId, sentiment, score);

      return { mentionId, sentiment, score };
    }

    // No JSON found in an otherwise-successful AI response — persist NEUTRAL
    // (unchanged pre-existing behavior), no error log (the provider DID respond).
    await deps.updateMention(mentionId, "NEUTRAL", 0);
    return { mentionId, sentiment: "NEUTRAL", score: 0 };
  } catch (error) {
    // Reached only when EVERY provider in the fallback chain has failed.
    const chainDesc = deps.providersAttempted.length > 0
      ? `all providers (${deps.providersAttempted.join(", ")}) failed`
      : "all providers failed";
    console.error(
      `[Sentiment] scoring unavailable for mention ${mentionId} — ${chainDesc}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    // Default to NEUTRAL on failure (unchanged persisted value for this light scope).
    await deps.updateMention(mentionId, "NEUTRAL", 0);
    return { mentionId, sentiment: "NEUTRAL", score: 0, error: true };
  }
}

const VALID_SENTIMENTS = ["POSITIVE", "NEGATIVE", "NEUTRAL", "MIXED"] as const;

function coerceVerdict(parsed: unknown): { sentiment: Sentiment; score: number } | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as { sentiment?: unknown; score?: unknown };
  const sentiment: Sentiment = (VALID_SENTIMENTS as readonly string[]).includes(p.sentiment as string)
    ? (p.sentiment as Sentiment)
    : "NEUTRAL";
  const score = typeof p.score === "number" && Number.isFinite(p.score) ? Math.max(-1, Math.min(1, p.score)) : 0;
  return { sentiment, score };
}

/**
 * Build the batch prompt: one numbered line per mention, each as a JSON
 * string literal so quotes and newlines inside a tweet cannot break the
 * numbering or escape the instruction. Exported for the test.
 */
export function buildBatchSentimentPrompt(items: SentimentMentionInput[]): string {
  const lines = items.map((m, i) => `${i}: ${JSON.stringify(m.content.slice(0, 500))}`).join("\n");
  return `Classify the sentiment of EACH numbered text below. Respond with ONLY a JSON array (no markdown, no explanation) containing exactly one object per text, in the same order:
[{"i": <number>, "sentiment": "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "MIXED", "score": <number from -1.0 to 1.0>}, ...]

${lines}`;
}

/**
 * Parse the model's array. Verdicts are matched by their "i" field, falling
 * back to array position when "i" is missing. Returns a sparse map — a text
 * the model skipped is simply absent, and the caller decides what that means.
 */
export function parseBatchSentimentResponse(raw: string, count: number): Map<number, { sentiment: Sentiment; score: number }> {
  const out = new Map<number, { sentiment: Sentiment; score: number }>();
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return out;
  let arr: unknown;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!Array.isArray(arr)) return out;
  arr.forEach((entry, position) => {
    const verdict = coerceVerdict(entry);
    if (!verdict) return;
    const i = entry && typeof (entry as { i?: unknown }).i === "number" ? Number((entry as { i: number }).i) : position;
    if (!Number.isInteger(i) || i < 0 || i >= count || out.has(i)) return;
    out.set(i, verdict);
  });
  return out;
}

/**
 * Score up to SENTIMENT_BATCH_SIZE mentions in ONE model call (2026-10-04).
 * Before this, every mention was its own job and its own call — a 3-keyword
 * query's first sync produced ~200 calls. Same persistence contract as the
 * single path: a verdict the model returned is written as-is; a mention it
 * skipped, or a response that cannot be parsed, or a chain where every
 * provider failed, persists NEUTRAL/0 (and the all-failed case logs the same
 * greppable line as scoreMentionSentiment).
 */
export async function scoreMentionsBatch(
  items: SentimentMentionInput[],
  deps: ScoreSentimentDeps,
): Promise<{ scored: number; defaulted: number; error?: true }> {
  if (items.length === 0) return { scored: 0, defaulted: 0 };
  if (items.length === 1) {
    const one = await scoreMentionSentiment(items[0]!.mentionId, items[0]!.content, deps);
    return one.error ? { scored: 0, defaulted: 1, error: true } : { scored: 1, defaulted: 0 };
  }

  let verdicts = new Map<number, { sentiment: Sentiment; score: number }>();
  let error: true | undefined;
  try {
    const result = await deps.generateContentWithFallback(buildBatchSentimentPrompt(items));
    verdicts = parseBatchSentimentResponse(result, items.length);
  } catch (err) {
    error = true;
    const chainDesc = deps.providersAttempted.length > 0
      ? `all providers (${deps.providersAttempted.join(", ")}) failed`
      : "all providers failed";
    console.error(
      `[Sentiment] scoring unavailable for ${items.length} mentions (batch) — ${chainDesc}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let scored = 0;
  let defaulted = 0;
  await Promise.all(
    items.map(async (m, i) => {
      const v = verdicts.get(i);
      if (v) {
        scored++;
        await deps.updateMention(m.mentionId, v.sentiment, v.score);
      } else {
        defaulted++;
        await deps.updateMention(m.mentionId, "NEUTRAL", 0);
      }
    }),
  );
  if (!error && defaulted > 0) {
    console.warn(`[Sentiment] batch of ${items.length}: model returned no verdict for ${defaulted}; persisted NEUTRAL/0 for those`);
  }
  return error ? { scored, defaulted, error } : { scored, defaulted };
}

export function createSentimentAnalysisWorker() {
  const worker = new Worker<SentimentAnalysisJobData>(
    QUEUE_NAMES.SENTIMENT_ANALYSIS,
    async (job: Job<SentimentAnalysisJobData>) => {
      const { buildTextProviderChain } = await import("@postautomation/ai");
      const providersAttempted = buildTextProviderChain(undefined);

      const deps: ScoreSentimentDeps = {
        generateContentWithFallback: async (prompt) => {
          const { generateContent, withTextProviderFallback } = await import("@postautomation/ai");
          return withTextProviderFallback(
            undefined,
            (provider) =>
              generateContent({
                provider: provider as Parameters<typeof generateContent>[0]["provider"],
                platform: "twitter",
                userPrompt: prompt,
                tone: "analytical",
              }),
            (failed, next, e) =>
              console.warn(
                `[SentimentAnalysis] Provider ${failed} failed (${
                  e instanceof Error ? e.message.slice(0, 80) : e
                }), trying ${next}`,
              ),
          );
        },
        updateMention: (id, sentiment, score) =>
          prisma.mention.update({
            where: { id },
            data: { sentiment, sentimentScore: score },
          }),
        providersAttempted,
      };

      // Batch jobs (listening-sync since 2026-10-04) and legacy single-mention
      // jobs (anything still queued from the previous build) are both served.
      if ("mentions" in job.data) {
        return scoreMentionsBatch(job.data.mentions, deps);
      }
      return scoreMentionSentiment(job.data.mentionId, job.data.content, deps);
    },
    {
      connection: createRedisConnection(),
      concurrency: 10,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[SentimentAnalysis] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
