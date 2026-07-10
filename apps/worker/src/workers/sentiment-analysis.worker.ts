import { Worker, type Job } from "bullmq";
import { prisma, type Sentiment } from "@postautomation/db";
import {
  QUEUE_NAMES,
  type SentimentAnalysisJobData,
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
 * instead of a single hardcoded provider. The worker passes the literal
 * string "anthropic" as the chosen provider, so buildTextProviderChain("anthropic")
 * resolves to ["anthropic", "openai"] (deduped) — it tries anthropic first
 * and falls back to openai if anthropic fails, rather than the [chosen→openai→
 * anthropic] ordering seen at other call sites where `chosen` is a variable.
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

export function createSentimentAnalysisWorker() {
  const worker = new Worker<SentimentAnalysisJobData>(
    QUEUE_NAMES.SENTIMENT_ANALYSIS,
    async (job: Job<SentimentAnalysisJobData>) => {
      const { mentionId, content } = job.data;

      const { buildTextProviderChain } = await import("@postautomation/ai");
      const providersAttempted = buildTextProviderChain("anthropic");

      return scoreMentionSentiment(mentionId, content, {
        generateContentWithFallback: async (prompt) => {
          const { generateContent, withTextProviderFallback } = await import("@postautomation/ai");
          return withTextProviderFallback(
            "anthropic",
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
      });
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
