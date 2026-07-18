import { prisma } from "@postautomation/db";
import { tokenRefreshQueue, analyticsSyncQueue, agentRunQueue, trendDiscoverQueue, listeningSyncQueue, campaignAnalyticsSyncQueue, brandContentSyncQueue, outreachPollQueue, postPublishQueue, rssSyncQueue, avatarCacheQueue } from "@postautomation/queue";
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
 * Re-cache channel avatars to durable S3 storage (platform CDN avatar URLs
 * expire — IG/FB signed URLs die in days). Run daily; the per-day jobId
 * dedupes re-enqueues within the same UTC day.
 */
export async function scheduleAvatarCache() {
  const activeChannels = await prisma.channel.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  let queued = 0;
  for (const channel of activeChannels) {
    // NOTE: BullMQ only allows ':' in custom jobIds when there are EXACTLY
    // three colon-separated segments — keep this shape if you change the id.
    await avatarCacheQueue.add(
      `avatar-${channel.id}`,
      { channelId: channel.id },
      { jobId: `avatar:${channel.id}:${day}`, removeOnComplete: true, removeOnFail: 100 }
    );
    queued++;
  }

  if (queued > 0) {
    console.log(`[Cron] Queued ${queued} avatar cache jobs`);
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
 * Enqueue RSS sync jobs for active feeds whose checkInterval has elapsed.
 * Run every 5 minutes; honors each feed's per-feed checkInterval (minutes).
 */
export async function scheduleRssSync() {
  const now = Date.now();
  const feeds = await prisma.rssFeed.findMany({
    where: { isActive: true },
    select: { id: true, organizationId: true, checkInterval: true, lastCheckedAt: true },
  });

  let queued = 0;
  for (const feed of feeds) {
    const dueAt = feed.lastCheckedAt
      ? feed.lastCheckedAt.getTime() + feed.checkInterval * 60 * 1000
      : 0; // never checked → due immediately
    if (now < dueAt) continue;

    await rssSyncQueue.add(
      `rss-sync-cron-${feed.id}`,
      { feedId: feed.id, organizationId: feed.organizationId },
      { jobId: `rss-sync-cron-${feed.id}-${now}`, removeOnComplete: true, removeOnFail: 100 }
    );
    queued++;
  }

  if (queued > 0) console.log(`[Cron] Queued ${queued} RSS sync jobs`);
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
 * Run every 4 hours on the dedicated BRAND_CONTENT_SYNC queue.
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
    await brandContentSyncQueue.add(
      `brand-sync-cron-${organizationId}`,
      { organizationId },
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
 * Fix #22/#30: Watchdog for stuck posts.
 * Any post that has been in PUBLISHING state for > 30 minutes without progress is
 * considered stuck. We inspect its targets:
 *   - All targets terminal (PUBLISHED or FAILED) → set post status to match
 *   - Otherwise → set post to FAILED so users know it needs attention
 * Runs every 5 minutes.
 */
export async function watchdogPublishingPosts() {
  const stuckThreshold = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago

  const stuckPosts = await prisma.post.findMany({
    where: { status: "PUBLISHING", updatedAt: { lt: stuckThreshold } },
    include: { targets: { select: { status: true } } },
  });

  if (stuckPosts.length === 0) return;

  console.log(`[Watchdog] Found ${stuckPosts.length} stuck PUBLISHING post(s)`);

  for (const post of stuckPosts) {
    const statuses = post.targets.map((t: any) => t.status as string);
    const allTerminal = statuses.every((s) => s === "PUBLISHED" || s === "FAILED" || s === "CANCELLED");
    const anyPublished = statuses.some((s) => s === "PUBLISHED");

    if (allTerminal) {
      const newStatus = anyPublished ? "PUBLISHED" : "FAILED";
      await prisma.post.update({
        where: { id: post.id },
        data: { status: newStatus, publishedAt: anyPublished ? new Date() : undefined },
      });
      console.log(`[Watchdog] Post ${post.id}: set to ${newStatus} (all targets terminal)`);
    } else {
      // Targets not terminal but post is stuck → fail it so users can retry
      await prisma.post.update({ where: { id: post.id }, data: { status: "FAILED" } });
      console.log(`[Watchdog] Post ${post.id}: set to FAILED (stuck with non-terminal targets)`);
    }
  }
}

/**
 * Build the where-clause for purging old ErrorLog rows.
 *
 * Pure (takes `now` + windows) so the date math is unit-testable without a DB.
 *   - resolved rows older than `resolvedDays` (by resolvedAt; fallback lastSeenAt
 *     for legacy rows resolved before resolvedAt was populated)
 *   - unresolved rows older than `staleDays` (never actioned → drop the noise)
 */
export function buildErrorLogPurgeWhere(now: Date, resolvedDays: number, staleDays: number) {
  const resolvedCutoff = new Date(now.getTime() - resolvedDays * 24 * 60 * 60 * 1000);
  const staleCutoff = new Date(now.getTime() - staleDays * 24 * 60 * 60 * 1000);
  return {
    OR: [
      {
        resolved: true,
        OR: [
          { resolvedAt: { lt: resolvedCutoff } },
          { resolvedAt: null, lastSeenAt: { lt: resolvedCutoff } },
        ],
      },
      { resolved: false, lastSeenAt: { lt: staleCutoff } },
    ],
  };
}

/**
 * Auto-purge old ErrorLog rows to keep the Monitoring table clean.
 * Run daily. Resolved>30d and stale-unresolved>90d are deleted.
 */
export async function purgeOldErrorLogs(): Promise<number> {
  const where = buildErrorLogPurgeWhere(new Date(), 30, 90);
  const { count } = await prisma.errorLog.deleteMany({ where });
  if (count > 0) {
    console.log(`[Cron:Cleanup] Purged ${count} old ErrorLog rows (resolved>30d, stale-unresolved>90d)`);
  }
  return count;
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

  // RSS sync every 5 minutes (honors per-feed checkInterval)
  setInterval(scheduleRssSync, 5 * 60 * 1000);
  setTimeout(scheduleRssSync, 90 * 1000); // Start after 90s warmup

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

  // Avatar re-cache daily (per-day jobId dedupes within the same UTC day)
  setInterval(scheduleAvatarCache, 24 * 60 * 60 * 1000);
  setTimeout(scheduleAvatarCache, 4 * 60 * 1000); // Start after 4 min warmup

  console.log("[Cron] Cron jobs started");
  console.log("[Cron]   - Token refresh: every 30 min");
  console.log("[Cron]   - Analytics sync: every 6 hours");
  console.log("[Cron]   - Agent runs: every 1 min");
  console.log("[Cron]   - Autopilot cleanup: every 1 hour");
  console.log("[Cron]   - Autopilot pipeline: every 15 min");
  console.log("[Cron]   - Listening sync: every 30 min");
  console.log("[Cron]   - RSS sync: every 5 min (per-feed interval)");
  console.log("[Cron]   - Campaign analytics sync: every 4 hours");
  console.log("[Cron]   - Brand content sync: every 4 hours");
  console.log("[Cron]   - Outreach poll: every 5 min");
  console.log("[Cron]   - Scheduled post publisher: every 2 min");
  console.log("[Cron]   - Celebrity-brand detection: every 6 hours");
  console.log("[Cron]   - Avatar re-cache: every 24 hours");

  // Auto-healer: scan for failed jobs, classify errors, retry transient failures
  setInterval(runAutoHealerWithLogging, 10 * 60 * 1000); // every 10 minutes
  setTimeout(runAutoHealerWithLogging, 3 * 60 * 1000); // Start after 3 min warmup

  // Fix #22/#30: watchdog for stuck PUBLISHING posts
  setInterval(watchdogPublishingPosts, 5 * 60 * 1000); // every 5 minutes
  setTimeout(watchdogPublishingPosts, 2 * 60 * 1000); // Start after 2 min warmup

  // ErrorLog auto-purge: keep the Monitoring table clean. Run daily.
  setInterval(purgeOldErrorLogs, 24 * 60 * 60 * 1000); // every 24 hours
  setTimeout(purgeOldErrorLogs, 6 * 60 * 1000); // Start after 6 min warmup

  console.log("[Cron]   - Auto-healer: every 10 min");
  console.log("[Cron]   - Publishing watchdog: every 5 min");
  console.log("[Cron]   - ErrorLog purge: every 24 hours");
}
