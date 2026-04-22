import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { getSocialProvider } from "@postautomation/social";
import { QUEUE_NAMES, type AnalyticsSyncJobData, createRedisConnection } from "@postautomation/queue";

export function createAnalyticsSyncWorker() {
  const worker = new Worker<AnalyticsSyncJobData>(
    QUEUE_NAMES.ANALYTICS_SYNC,
    async (job: Job<AnalyticsSyncJobData>) => {
      const { postTargetId, channelId, platform, platformPostId } = job.data;
      console.log(`[AnalyticsSync] Processing job ${job.id} for target ${postTargetId}`);

      // 1. Get channel tokens
      const channel = await prisma.channel.findUniqueOrThrow({
        where: { id: channelId },
      });

      // 2. Fetch analytics from the platform
      const provider = getSocialProvider(platform as any);
      const tokens = {
        accessToken: channel.accessToken,
        refreshToken: channel.refreshToken ?? undefined,
      };

      let analytics;
      try {
        analytics = await provider.getPostAnalytics(tokens, platformPostId);
      } catch (err: any) {
        console.warn(`[AnalyticsSync] getPostAnalytics threw for ${platform} post ${platformPostId}: ${err.message}`);
        return null;
      }

      if (!analytics) {
        console.warn(`[AnalyticsSync] No analytics returned for ${platform} post ${platformPostId} (target: ${postTargetId})`);
        return null;
      }

      // 3. Save analytics snapshot
      const snapshot = await prisma.analyticsSnapshot.create({
        data: {
          postTargetId,
          platform: platform as any,
          impressions: analytics.impressions ?? 0,
          clicks: analytics.clicks ?? 0,
          likes: analytics.likes ?? 0,
          shares: analytics.shares ?? 0,
          comments: analytics.comments ?? 0,
          reach: analytics.reach ?? 0,
          engagementRate: analytics.engagementRate ?? 0,
          snapshotAt: new Date(),
        },
      });

      console.log(`[AnalyticsSync] Saved analytics snapshot ${snapshot.id} for target ${postTargetId}`);
      return snapshot;
    },
    {
      connection: createRedisConnection(),
      // Concurrency 2: prevents 10 simultaneous calls from bypassing the
      // in-memory usage cache in facebook.provider.ts (race condition where
      // all jobs pass throttleIfNeeded() before any response comes back).
      concurrency: 2,
      limiter: { max: 5, duration: 1000 },
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[AnalyticsSync] Job ${job?.id} failed:`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[AnalyticsSync] Job ${job.id} completed`);
  });

  return worker;
}
