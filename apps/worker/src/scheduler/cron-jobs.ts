import { prisma } from "@postautomation/db";
import { tokenRefreshQueue, analyticsSyncQueue, agentRunQueue, trendDiscoverQueue, listeningSyncQueue, campaignAnalyticsSyncQueue, outreachPollQueue, postPublishQueue } from "@postautomation/queue";
import { runAutoHealerWithLogging } from "../workers/auto-healer.worker";
import { runCelebrityDetectors } from "../workers/celebrity-detect.worker";

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
  // Only sync the last 7 days (30-day window burns FB quota fast).
  // Facebook is skipped entirely — their Graph API rate-limits are per-app
  // and analytics calls (insights + reactions) cost 2 calls per post.
  // Re-enable FACEBOOK once quota resets and a dedicated FB analytics queue
  // with concurrency=1 is in place.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const publishedTargets = await prisma.postTarget.findMany({
    where: {
      status: "PUBLISHED",
      publishedId: { not: null },
      publishedAt: { gte: sevenDaysAgo },
      channel: {
        isActive: true,
        platform: { not: "FACEBOOK" }, // FB excluded — restores quota
      },
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
 * Sync listening queries: fetch new mentions for active queries.
 * Run every 30 minutes.
 */
export async function scheduleListeningSync() {
  const activeQueries = await prisma.listeningQuery.findMany({
    where: { isActive: true },
    select: { id: true, organizationId: true },
  });

  let queued = 0;
  for (const query of activeQueries) {
    await listeningSyncQueue.add(
      `listening-sync-cron-${query.id}`,
      { listeningQueryId: query.id, organizationId: query.organizationId },
      { jobId: `listening-sync-cron-${query.id}-${Date.now()}`, removeOnComplete: true, removeOnFail: 100 }
    );
    queued++;
  }

  if (queued > 0) {
    console.log(`[Cron] Queued ${queued} listening sync jobs`);
  }
}

/**
 * Sync campaign analytics: aggregate metrics for active campaigns.
 * Run every 4 hours.
 */
export async function scheduleCampaignAnalyticsSync() {
  const activeCampaigns = await prisma.campaign.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, organizationId: true },
  });

  let queued = 0;
  for (const campaign of activeCampaigns) {
    await campaignAnalyticsSyncQueue.add(
      `campaign-sync-cron-${campaign.id}`,
      { campaignId: campaign.id, organizationId: campaign.organizationId },
      { jobId: `campaign-sync-cron-${campaign.id}-${Date.now()}`, removeOnComplete: true, removeOnFail: 100 }
    );
    queued++;
  }

  if (queued > 0) {
    console.log(`[Cron] Queued ${queued} campaign analytics sync jobs`);
  }
}

/**
 * Sync brand content: fetch new content from tracked brands and discover influencers.
 * Run every 4 hours (shares queue with campaign analytics sync).
 */
export async function scheduleBrandContentSync() {
  // Get all orgs that have active brand trackers
  const orgsWithTrackers = await prisma.brandTracker.findMany({
    where: { isActive: true },
    select: { organizationId: true },
    distinct: ["organizationId"],
  });

  let queued = 0;
  for (const { organizationId } of orgsWithTrackers) {
    await campaignAnalyticsSyncQueue.add(
      `brand-sync-cron-${organizationId}`,
      { organizationId, campaignId: "" },
      { jobId: `brand-sync-cron-${organizationId}-${Date.now()}`, removeOnComplete: true, removeOnFail: 100 }
    );
    queued++;
  }

  if (queued > 0) {
    console.log(`[Cron] Queued ${queued} brand content sync jobs`);
  }
}

/**
 * Poll for approved outreach leads and queue send jobs.
 * Run every 5 minutes.
 */
export async function scheduleOutreachPoll() {
  const orgs = await prisma.organization.findMany({
    where: {
      celebrityBrandSignals: {
        some: {
          outreachLeads: { some: { status: "APPROVED", messages: { none: {} } } },
        },
      },
    },
    select: { id: true },
  });

  for (const org of orgs) {
    await outreachPollQueue.add(
      `outreach-poll-${org.id}`,
      { organizationId: org.id },
      { jobId: `outreach-poll-${org.id}-${Date.now()}`, removeOnComplete: true }
    );
  }

  if (orgs.length > 0) {
    console.log(`[Cron] Queued ${orgs.length} outreach poll jobs`);
  }
}

/**
 * Publish scheduled posts whose scheduledAt time has passed.
 * Run every 2 minutes — catches posts from Super Agent, manual scheduling, etc.
 */
export async function publishScheduledPosts() {
  const now = new Date();

  // Find posts that are SCHEDULED and their time has come
  const duePosts = await prisma.post.findMany({
    where: {
      status: "SCHEDULED",
      scheduledAt: { lte: now },
    },
    select: {
      id: true,
      organizationId: true,
      targets: {
        where: { status: "SCHEDULED" },
        select: {
          id: true,
          channelId: true,
          channel: { select: { platform: true } },
        },
      },
    },
    take: 50, // batch limit
  });

  let queued = 0;
  for (const post of duePosts) {
    for (let i = 0; i < post.targets.length; i++) {
      const target = post.targets[i]!;
      const jobId = `scheduled-publish-${post.id}-${target.channelId}-${Date.now()}`;

      await postPublishQueue.add(
        jobId,
        {
          postId: post.id,
          postTargetId: target.id,
          channelId: target.channelId,
          platform: target.channel.platform,
          organizationId: post.organizationId,
        },
        {
          delay: i * 10_000, // stagger 10s per channel
          attempts: 3,
          backoff: { type: "exponential", delay: 60_000 },
          removeOnComplete: true,
          removeOnFail: 100,
        }
      );
      queued++;
    }

    // Mark post as PUBLISHING so we don't re-queue it next cycle
    await prisma.post.update({
      where: { id: post.id },
      data: { status: "PUBLISHING" },
    });
  }

  if (queued > 0) {
    console.log(`[Cron:Scheduler] Queued ${queued} publish jobs for ${duePosts.length} scheduled posts`);
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

  // Listening sync every 30 minutes
  setInterval(scheduleListeningSync, 30 * 60 * 1000);
  setTimeout(scheduleListeningSync, 2 * 60 * 1000); // Start after 2 min warmup

  // Campaign analytics sync every 4 hours
  setInterval(scheduleCampaignAnalyticsSync, 4 * 60 * 60 * 1000);
  setTimeout(scheduleCampaignAnalyticsSync, 10 * 60 * 1000); // Start after 10 min warmup

  // Brand content sync every 4 hours
  setInterval(scheduleBrandContentSync, 4 * 60 * 60 * 1000);
  setTimeout(scheduleBrandContentSync, 12 * 60 * 1000); // Start after 12 min warmup

  // Outreach poll every 5 minutes
  setInterval(scheduleOutreachPoll, 5 * 60 * 1000);
  setTimeout(scheduleOutreachPoll, 3 * 60 * 1000); // Start after 3 min warmup

  // Scheduled post publisher every 2 minutes
  setInterval(publishScheduledPosts, 2 * 60 * 1000);
  setTimeout(publishScheduledPosts, 30 * 1000); // Start after 30s warmup

  // Celebrity-brand detection every 6 hours
  setInterval(runCelebrityDetectors, 6 * 60 * 60 * 1000);
  setTimeout(runCelebrityDetectors, 5 * 60 * 1000); // Start after 5 min warmup

  console.log("[Cron] Cron jobs started");
  console.log("[Cron]   - Token refresh: every 30 min");
  console.log("[Cron]   - Analytics sync: every 6 hours");
  console.log("[Cron]   - Agent runs: every 1 min");
  console.log("[Cron]   - Autopilot cleanup: every 1 hour");
  console.log("[Cron]   - Autopilot pipeline: every 15 min");
  console.log("[Cron]   - Listening sync: every 30 min");
  console.log("[Cron]   - Campaign analytics sync: every 4 hours");
  console.log("[Cron]   - Brand content sync: every 4 hours");
  console.log("[Cron]   - Outreach poll: every 5 min");
  console.log("[Cron]   - Scheduled post publisher: every 2 min");
  console.log("[Cron]   - Celebrity-brand detection: every 6 hours");

  // Auto-healer: scan for failed jobs, classify errors, retry transient failures
  setInterval(runAutoHealerWithLogging, 10 * 60 * 1000); // every 10 minutes
  setTimeout(runAutoHealerWithLogging, 3 * 60 * 1000); // Start after 3 min warmup

  console.log("[Cron]   - Auto-healer: every 10 min");
}
