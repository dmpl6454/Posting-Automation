import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import {
  QUEUE_NAMES,
  type SentimentAnalysisJobData,
  createRedisConnection,
} from "@postautomation/queue";

export function createSentimentAnalysisWorker() {
  const worker = new Worker<SentimentAnalysisJobData>(
    QUEUE_NAMES.SENTIMENT_ANALYSIS,
    async (job: Job<SentimentAnalysisJobData>) => {
      const { mentionId, content } = job.data;

      try {
        const { generateContent } = await import("@postautomation/ai");

        const prompt = `Analyze the sentiment of this text and respond with ONLY a JSON object (no markdown, no explanation):
{"sentiment": "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "MIXED", "score": <number from -1.0 to 1.0>}

Text: "${content.slice(0, 500)}"`;

        const result = await generateContent({
          provider: "anthropic",
          platform: "twitter",
          userPrompt: prompt,
          tone: "analytical",
        });

        // Parse the JSON response
        const jsonMatch = result.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const sentiment = ["POSITIVE", "NEGATIVE", "NEUTRAL", "MIXED"].includes(parsed.sentiment)
            ? parsed.sentiment
            : "NEUTRAL";
          const score = typeof parsed.score === "number"
            ? Math.max(-1, Math.min(1, parsed.score))
            : 0;

          await prisma.mention.update({
            where: { id: mentionId },
            data: { sentiment, sentimentScore: score },
          });

          return { mentionId, sentiment, score };
        }

        return { mentionId, sentiment: "NEUTRAL", score: 0 };
      } catch (error) {
        console.warn(`[SentimentAnalysis] Failed for mention ${mentionId}:`, error);
        // Default to NEUTRAL on failure
        await prisma.mention.update({
          where: { id: mentionId },
          data: { sentiment: "NEUTRAL", sentimentScore: 0 },
        });
        return { mentionId, sentiment: "NEUTRAL", score: 0, error: true };
      }
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
