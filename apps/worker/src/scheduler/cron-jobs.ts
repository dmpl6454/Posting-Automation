import { prisma } from "@postautomation/db";
import { tokenRefreshQueue, analyticsSyncQueue, agentRunQueue, trendDiscoverQueue } from "@postautomation/queue";

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
 * Autopilot cleanup: expire old trends, auto-reject stale reviews, complete stale pipeline runs.
 * Run every hour.
 */
export async function runAutopilotCleanup() {
  const now = new Date();

  // 1. Expire old TrendingItems (expiresAt < now, status not EXPIRED/POSTED)
  const expiredTrends = await prisma.trendingItem.updateMany({
    where: {
      expiresAt: { lt: now },
      status: { notIn: ["EXPIRED", "POSTED"] },
    },
    data: { status: "EXPIRED" },
  });

  if (expiredTrends.count > 0) {
    console.log(`[Cron:Cleanup] Expired ${expiredTrends.count} trending items`);
  }

  // 2. Auto-reject unreviewed AutopilotPosts (status REVIEWING, createdAt > 24h ago)
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const expiredReviews = await prisma.autopilotPost.updateMany({
    where: {
      status: "REVIEWING",
      createdAt: { lt: twentyFourHoursAgo },
    },
    data: { status: "EXPIRED" },
  });

  if (expiredReviews.count > 0) {
    console.log(`[Cron:Cleanup] Auto-expired ${expiredReviews.count} unreviewed autopilot posts`);
  }

  // 3. Complete stale PipelineRuns (status RUNNING, startedAt > 1h ago)
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const staleRuns = await prisma.pipelineRun.updateMany({
    where: {
      status: "RUNNING",
      startedAt: { lt: oneHourAgo },
    },
    data: {
      status: "COMPLETED",
      completedAt: now,
    },
  });

  if (staleRuns.count > 0) {
    console.log(`[Cron:Cleanup] Completed ${staleRuns.count} stale pipeline runs`);
  }
}

/**
 * Trigger autopilot pipeline for all orgs with active agents.
 * Run every 15 minutes.
 */
export async function triggerAutopilotPipeline() {
  // 1. Find all orgs with at least one active agent
  const orgsWithAgents = await prisma.agent.findMany({
    where: { isActive: true },
    select: { organizationId: true },
    distinct: ["organizationId"],
  });

  let queued = 0;
  for (const { organizationId } of orgsWithAgents) {
    // 2. Create PipelineRun record
    const pipelineRun = await prisma.pipelineRun.create({
      data: {
        organizationId,
        status: "RUNNING",
        startedAt: new Date(),
      },
    });

    // 3. Queue TREND_DISCOVER job
    await trendDiscoverQueue.add(
      `trend-discover-${organizationId}-${pipelineRun.id}`,
      {
        organizationId,
        pipelineRunId: pipelineRun.id,
      },
      {
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
    queued++;
  }

  if (queued > 0) {
    console.log(`[Cron:Pipeline] Triggered autopilot pipeline for ${queued} organizations`);
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

  // Autopilot cleanup every hour
  setInterval(runAutopilotCleanup, 60 * 60 * 1000);
  runAutopilotCleanup(); // Run immediately on startup

  // Autopilot pipeline trigger every 15 minutes
  setInterval(triggerAutopilotPipeline, 15 * 60 * 1000);
  setTimeout(triggerAutopilotPipeline, 60 * 1000); // Start after 1 minute warmup

  console.log("[Cron] Cron jobs started");
  console.log("[Cron]   - Token refresh: every 30 min");
  console.log("[Cron]   - Analytics sync: every 6 hours");
  console.log("[Cron]   - Agent runs: every 1 min");
  console.log("[Cron]   - Autopilot cleanup: every 1 hour");
  console.log("[Cron]   - Autopilot pipeline: every 15 min");
}
