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

      const analytics = await provider.getPostAnalytics(tokens, platformPostId);
      if (!analytics) {
        console.log(`[AnalyticsSync] No analytics data returned for ${postTargetId}`);
        return null;
      }

      // 3. Save analytics snapshot
      const snapshot = await prisma.analyticsSnapshot.create({
        data: {
          postTargetId,
          platform: platform as any,
          impressions: analytics.impressions,
          clicks: analytics.clicks,
          likes: analytics.likes,
          shares: analytics.shares,
          comments: analytics.comments,
          reach: analytics.reach,
          engagementRate: analytics.engagementRate,
          snapshotAt: new Date(),
        },
      });

      console.log(`[AnalyticsSync] Saved analytics snapshot ${snapshot.id} for target ${postTargetId}`);
      return snapshot;
    },
    {
      connection: createRedisConnection(),
      concurrency: 10,
      limiter: { max: 20, duration: 1000 },
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
