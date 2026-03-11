import { prisma } from "@postautomation/db";
import { tokenRefreshQueue, analyticsSyncQueue, agentRunQueue } from "@postautomation/queue";

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
 * Check active agents and queue runs when their cron schedule matches.
 * Run every minute.
 */
export async function scheduleAgentRuns() {
  const now = new Date();
  const currentMinute = now.getUTCMinutes();
  const currentHour = now.getUTCHours();

  const activeAgents = await prisma.agent.findMany({
    where: { isActive: true },
    select: { id: true, organizationId: true, cronExpression: true, lastRunAt: true },
  });

  let queued = 0;
  for (const agent of activeAgents) {
    // Parse cron: "minute hour * * *"
    const parts = agent.cronExpression.split(" ");
    const cronMinute = parseInt(parts[0]!, 10);
    const cronHour = parseInt(parts[1]!, 10);

    if (cronMinute !== currentMinute || cronHour !== currentHour) {
      continue;
    }

    // Check if already ran today (prevent duplicate runs)
    if (agent.lastRunAt) {
      const lastRun = new Date(agent.lastRunAt);
      if (
        lastRun.getUTCFullYear() === now.getUTCFullYear() &&
        lastRun.getUTCMonth() === now.getUTCMonth() &&
        lastRun.getUTCDate() === now.getUTCDate()
      ) {
        continue;
      }
    }

    await agentRunQueue.add(
      `agent-run-${agent.id}`,
      { agentId: agent.id, organizationId: agent.organizationId },
      { jobId: `agent-run-${agent.id}-${Date.now()}`, removeOnComplete: true, removeOnFail: 100 }
    );
    queued++;
  }

  if (queued > 0) {
    console.log(`[Cron] Queued ${queued} agent run jobs`);
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

  // Agent run check every minute
  setInterval(scheduleAgentRuns, 60 * 1000);
  scheduleAgentRuns(); // Run immediately on startup

  console.log("[Cron] Cron jobs started");
  console.log("[Cron]   - Token refresh: every 30 min");
  console.log("[Cron]   - Analytics sync: every 6 hours");
  console.log("[Cron]   - Agent runs: every 1 min");
}
