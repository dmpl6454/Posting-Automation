import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import {
  QUEUE_NAMES,
  contentGenerateQueue,
  type TrendScoreJobData,
  type ContentGenerateJobData,
  createRedisConnection,
} from "@postautomation/queue";
import {
  calculateTrendScore,
  calculateNicheRelevance,
  classifySensitivity,
} from "@postautomation/ai";
import IORedis from "ioredis";

export function createTrendScoreWorker() {
  const redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });

  const worker = new Worker<TrendScoreJobData>(
    QUEUE_NAMES.TREND_SCORE,
    async (job: Job<TrendScoreJobData>) => {
      const { trendingItemId, organizationId, pipelineRunId } = job.data;
      console.log(
        `[TrendScore] Processing job ${job.id} for item ${trendingItemId}`,
      );

      // 1. Fetch the TrendingItem by id. Skip if not found or status !== "NEW".
      const item = await prisma.trendingItem.findUnique({
        where: { id: trendingItemId },
      });

      if (!item || item.status !== "NEW") {
        console.log(
          `[TrendScore] Skipping item ${trendingItemId}: ${!item ? "not found" : `status=${item.status}`}`,
        );
        return { skipped: true, reason: !item ? "not_found" : "not_new" };
      }

      // 2. Fetch all active agents in the org, including their accountGroup relation.
      const agents = await prisma.agent.findMany({
        where: { organizationId, isActive: true },
        include: { accountGroup: true },
      });

      // 3. Classify sensitivity using classifySensitivity(title, summary).
      const sensitivity = classifySensitivity(
        item.title,
        item.summary ?? undefined,
      );

      let maxScore = 0;
      let matchCount = 0;
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

      // 4. For each agent:
      for (const agent of agents) {
        // a. Get threshold from agent.accountGroup?.trendScoreThreshold ?? 40
        const threshold = agent.accountGroup?.trendScoreThreshold ?? 40;

        // b. Get postsPerDay from agent.accountGroup?.postsPerDay ?? agent.postsPerDay
        const postsPerDay =
          agent.accountGroup?.postsPerDay ?? agent.postsPerDay;

        // c. Calculate score using calculateTrendScore() with item + agent topics
        const agentTopics =
          agent.topics.length > 0
            ? agent.topics
            : agent.niche
              ? [agent.niche]
              : ["general"];

        const score = calculateTrendScore({
          publishedAt: item.publishedAt,
          sourceName: item.sourceName,
          viralSignal: item.viralSignal ?? undefined,
          sourceType: item.sourceType.toLowerCase(),
          itemTopics: item.topics,
          agentTopics,
        });

        // d. Skip if score < threshold
        if (score < threshold) {
          continue;
        }

        // e. Check niche relevance — skip if 0 and topics aren't ["general"]
        const nicheRelevance = calculateNicheRelevance(
          item.topics,
          agentTopics,
        );
        if (
          nicheRelevance === 0 &&
          !(agentTopics.length === 1 && agentTopics[0] === "general")
        ) {
          continue;
        }

        // f. Check daily quota via Redis atomic counter
        const quotaKey = `autopilot:quota:${agent.id}:${today}`;
        const count = await redis.incr(quotaKey);

        // Set TTL on first increment
        if (count === 1) {
          await redis.expire(quotaKey, 86400);
        }

        // If count > postsPerDay, DECR and skip
        if (count > postsPerDay) {
          await redis.decr(quotaKey);
          console.log(
            `[TrendScore] Agent ${agent.id} quota exceeded (${count}/${postsPerDay})`,
          );
          continue;
        }

        // g. Create AutopilotPost record (handle P2002 unique constraint = already matched, DECR quota)
        try {
          const autopilotPost = await prisma.autopilotPost.create({
            data: {
              organizationId,
              trendingItemId,
              agentId: agent.id,
              sensitivity,
              trendScore: score,
            },
          });

          // h. Queue CONTENT_GENERATE job for the new AutopilotPost
          await contentGenerateQueue.add(
            `generate-${autopilotPost.id}`,
            {
              autopilotPostId: autopilotPost.id,
              organizationId,
              pipelineRunId,
            } satisfies ContentGenerateJobData,
            {
              removeOnComplete: true,
              removeOnFail: 100,
            },
          );

          matchCount++;
          console.log(
            `[TrendScore] Matched agent ${agent.id} with score ${score} for item ${trendingItemId}`,
          );
        } catch (error: any) {
          // P2002: Unique constraint violation — already matched
          if (error?.code === "P2002") {
            await redis.decr(quotaKey);
            console.log(
              `[TrendScore] Already matched item ${trendingItemId} to agent ${agent.id}`,
            );
            continue;
          }
          throw error;
        }

        // i. Track max score across all agent matches
        if (score > maxScore) {
          maxScore = score;
        }
      }

      // 5. Update TrendingItem: status="SCORED", trendScore=maxScore, sensitivity
      await prisma.trendingItem.update({
        where: { id: trendingItemId },
        data: {
          status: "SCORED",
          trendScore: maxScore,
          sensitivity,
        },
      });

      // 6. Update PipelineRun: increment itemsScored
      await prisma.pipelineRun.update({
        where: { id: pipelineRunId },
        data: {
          itemsScored: { increment: 1 },
        },
      });

      console.log(
        `[TrendScore] Done. Item ${trendingItemId} scored ${maxScore}, ${matchCount} agent matches`,
      );

      return { trendingItemId, maxScore, matchCount };
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[TrendScore] Job ${job?.id} failed:`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[TrendScore] Job ${job.id} completed`);
  });

  return worker;
}
