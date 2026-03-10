import { prisma } from "@postautomation/db";
import { tokenRefreshQueue, analyticsSyncQueue } from "@postautomation/queue";

/**
 * Check for channels with expiring tokens and queue refresh jobs.
 * Run every 30 minutes.
 */
export async function scheduleTokenRefreshes() {
  const soon = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

  const expiringChannels = await prisma.channel.findMany({
    where: {
      isActive: true,
      refreshToken: { not: null },
      tokenExpiresAt: { lte: soon },
    },
    select: { id: true, platform: true },
  });

  for (const channel of expiringChannels) {
    await tokenRefreshQueue.add(
      `refresh-${channel.id}`,
      { channelId: channel.id, platform: channel.platform },
      { jobId: `refresh-${channel.id}`, removeOnComplete: true }
    );
  }

  if (expiringChannels.length > 0) {
    console.log(`[Cron] Queued ${expiringChannels.length} token refresh jobs`);
  }
}

/**
 * Queue analytics sync jobs for all published post targets.
 * Run every 6 hours to collect engagement metrics.
 */
export async function scheduleAnalyticsSync() {
  // Get all published post targets from the last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const publishedTargets = await prisma.postTarget.findMany({
    where: {
      status: "PUBLISHED",
      publishedId: { not: null },
      publishedAt: { gte: thirtyDaysAgo },
      channel: { isActive: true },
    },
    select: {
      id: true,
      publishedId: true,
      channelId: true,
      channel: { select: { platform: true } },
    },
  });

  let queued = 0;
  for (const target of publishedTargets) {
    if (!target.publishedId) continue;

    await analyticsSyncQueue.add(
      `analytics-${target.id}`,
      {
        postTargetId: target.id,
        platform: target.channel.platform,
        channelId: target.channelId,
        platformPostId: target.publishedId,
      },
      {
        jobId: `analytics-${target.id}-${Date.now()}`,
        removeOnComplete: true,
        removeOnFail: 100,
      }
    );
    queued++;
  }

  if (queued > 0) {
    console.log(`[Cron] Queued ${queued} analytics sync jobs`);
  }
}

/**
 * Start all cron jobs
 */
export function startCronJobs() {
  // Token refresh check every 30 minutes
  setInterval(scheduleTokenRefreshes, 30 * 60 * 1000);
  scheduleTokenRefreshes(); // Run immediately on startup

  // Analytics sync every 6 hours
  setInterval(scheduleAnalyticsSync, 6 * 60 * 60 * 1000);
  // Run analytics sync 5 minutes after startup (give tokens time to refresh)
  setTimeout(scheduleAnalyticsSync, 5 * 60 * 1000);

  console.log("[Cron] Cron jobs started");
  console.log("[Cron]   - Token refresh: every 30 min");
  console.log("[Cron]   - Analytics sync: every 6 hours");
}
