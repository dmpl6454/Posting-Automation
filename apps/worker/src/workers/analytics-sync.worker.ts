import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { getSocialProvider } from "@postautomation/social";
import { QUEUE_NAMES, type AnalyticsSyncJobData, createRedisConnection } from "@postautomation/queue";
import { buildSnapshotMetadata } from "../lib/snapshot-metadata";

export function createAnalyticsSyncWorker() {
  const worker = new Worker<AnalyticsSyncJobData>(
    QUEUE_NAMES.ANALYTICS_SYNC,
    async (job: Job<AnalyticsSyncJobData>) => {
      const { postTargetId, channelId, platform, platformPostId, windowTag, capturedLate } = job.data;
      console.log(`[AnalyticsSync] Processing job ${job.id} for target ${postTargetId}${windowTag ? ` (at-age checkpoint ${windowTag})` : ""}`);

      // 1. Get channel tokens
      const channel = await prisma.channel.findUniqueOrThrow({
        where: { id: channelId },
      });

      // 2. Fetch analytics from the platform
      const provider = getSocialProvider(platform as any);
      const tokens = {
        accessToken: channel.accessToken,
        refreshToken: channel.refreshToken ?? undefined,
        // Thread channel metadata into tokens (mirrors the avatar-cache
        // precedent): LinkedIn Page channels carry { orgId } here, which
        // getPostAnalytics needs for organizationalEntityShareStatistics
        // (impressions/clicks/shares — member posts have no analytics API).
        metadata: (channel.metadata ?? undefined) as Record<string, unknown> | undefined,
      };

      let analytics;
      try {
        analytics = await provider.getPostAnalytics(tokens, platformPostId);
      } catch (err: any) {
        console.warn(`[AnalyticsSync] getPostAnalytics threw for ${platform} post ${platformPostId}: ${err.message}`);
        // At-age checkpoint jobs (windowTag) are ONE-SHOT — a swallowed error
        // here permanently loses the checkpoint. Rethrow so BullMQ's default
        // attempts:3 + exponential backoff engages. Untagged cron jobs keep
        // the soft null return (the next periodic pass covers them).
        if (windowTag) throw err;
        return null;
      }

      if (!analytics) {
        console.warn(`[AnalyticsSync] No analytics returned for ${platform} post ${platformPostId} (target: ${postTargetId})`);
        // Same one-shot rule: null at a checkpoint counts as a failure so the
        // job retries instead of completing with the checkpoint lost.
        if (windowTag) {
          throw new Error(`No analytics returned for ${platform} post ${platformPostId} at checkpoint ${windowTag}`);
        }
        return null;
      }

      // 3. Save analytics snapshot. At-age checkpoint jobs (delayed, enqueued at
      // publish) stamp metadata.windowTag so Reports "at publish-age" mode can
      // pin the metrics as they stood exactly 24h/7d/15d/30d after publish.
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
          ...(() => {
            const md = buildSnapshotMetadata(analytics as any, windowTag, !!capturedLate);
            return md ? { metadata: md as any } : {};
          })(),
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
