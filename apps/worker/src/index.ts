// Force IPv4 DNS resolution to prevent ETIMEDOUT on IPv6-unreachable hosts (e.g. LinkedIn API in Docker)
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { createPostPublishWorker } from "./workers/post-publish.worker";
import { createTokenRefreshWorker } from "./workers/token-refresh.worker";
import { createAnalyticsSyncWorker } from "./workers/analytics-sync.worker";
import { createWebhookDeliveryWorker } from "./workers/webhook-delivery.worker";
import { createMediaProcessWorker } from "./workers/media-process.worker";
import { createRssSyncWorker } from "./workers/rss-sync.worker";
import { createAgentRunWorker } from "./workers/agent-run.worker";
import { createTrendDiscoverWorker } from "./workers/trend-discover.worker";
import { createTrendScoreWorker } from "./workers/trend-score.worker";
import { createContentGenerateWorker } from "./workers/content-generate.worker";
import { createAutopilotScheduleWorker } from "./workers/autopilot-schedule.worker";
import { createListeningSyncWorker } from "./workers/listening-sync.worker";
import { createSentimentAnalysisWorker } from "./workers/sentiment-analysis.worker";
import { createCampaignAnalyticsSyncWorker } from "./workers/campaign-analytics-sync.worker";
import { createBrandContentSyncWorker } from "./workers/brand-content-sync.worker";
import { createOutreachSendWorker } from "./workers/outreach-send.worker";
import { createOutreachPollWorker } from "./workers/outreach-poll.worker";
import { createRepurposeVideoWorker } from "./workers/repurpose-video.worker";
import { createAvatarCacheWorker } from "./workers/avatar-cache.worker";
import { createExternalPostSyncWorker } from "./workers/external-post-sync.worker";
import { createCaptionFanoutWorker } from "./workers/caption-fanout.worker";
import { createMediaOptimizeWorker } from "./workers/media-optimize.worker";
import { createSuperTextWorker } from "./workers/super-text.worker";
import { startCronJobs } from "./scheduler/cron-jobs";
import { registerWorker, markWorkerStopped, startHealthServer } from "./lib/health";
import { createGracefulShutdown, readActiveJobCount, resolveShutdownTimeoutMs } from "./lib/shutdown";
import { awaitBackgroundTasks, pendingBackgroundTaskCount } from "./lib/background-tasks";

console.log("=== Post Automation Worker Starting ===");

// Register workers for health checks
registerWorker("post-publish");
registerWorker("token-refresh");
registerWorker("analytics-sync");
registerWorker("webhook-delivery");
registerWorker("media-process");
registerWorker("rss-sync");
registerWorker("agent-run");
registerWorker("trend-discover");
registerWorker("trend-score");
registerWorker("content-generate");
registerWorker("autopilot-schedule");
registerWorker("listening-sync");
registerWorker("sentiment-analysis");
registerWorker("campaign-analytics-sync");
registerWorker("brand-content-sync");
registerWorker("outreach-send");
registerWorker("outreach-poll");
registerWorker("repurpose-video");
registerWorker("avatar-cache");
registerWorker("caption-fanout");
registerWorker("super-text");

// Start workers
const postPublishWorker = createPostPublishWorker();
const tokenRefreshWorker = createTokenRefreshWorker();
const analyticsSyncWorker = createAnalyticsSyncWorker();
const webhookDeliveryWorker = createWebhookDeliveryWorker();
const mediaProcessWorker = createMediaProcessWorker();
const rssSyncWorker = createRssSyncWorker();
const agentRunWorker = createAgentRunWorker();
const trendDiscoverWorker = createTrendDiscoverWorker();
const trendScoreWorker = createTrendScoreWorker();
const contentGenerateWorker = createContentGenerateWorker();
const autopilotScheduleWorker = createAutopilotScheduleWorker();
const listeningSyncWorker = createListeningSyncWorker();
const sentimentAnalysisWorker = createSentimentAnalysisWorker();
const campaignAnalyticsSyncWorker = createCampaignAnalyticsSyncWorker();
const brandContentSyncWorker = createBrandContentSyncWorker();
const outreachSendWorker = createOutreachSendWorker();
const outreachPollWorker = createOutreachPollWorker();
const repurposeVideoWorker = createRepurposeVideoWorker();
const avatarCacheWorker = createAvatarCacheWorker();
const captionFanoutWorker = createCaptionFanoutWorker();
const mediaOptimizeWorker = createMediaOptimizeWorker();
const superTextWorker = createSuperTextWorker();
const externalPostSyncWorker = createExternalPostSyncWorker();

// Start cron jobs — leader-gated for future multi-worker scale-out: the
// setInterval crons must run in EXACTLY ONE container or every scheduled
// scan/sync double-fires (the publish path would survive via the atomic
// claim, but analytics/RSS/outreach syncs would all duplicate). Default ON —
// today's single-worker deploy is unchanged; set CRON_LEADER=false ONLY on
// additional worker replicas (they then do pure queue processing).
if (process.env.CRON_LEADER !== "false") {
  startCronJobs();
} else {
  console.log("[Cron] CRON_LEADER=false — crons disabled on this instance (queue processing only)");
}

// Start health check HTTP server
const healthServer = startHealthServer();

console.log("=== Workers Running ===");
console.log("  - Post Publish Worker");
console.log("  - Token Refresh Worker");
console.log("  - Analytics Sync Worker");
console.log("  - Webhook Delivery Worker");
console.log("  - Media Process Worker");
console.log("  - RSS Sync Worker");
console.log("  - Agent Run Worker");
console.log("  - Trend Discover Worker");
console.log("  - Trend Score Worker");
console.log("  - Content Generate Worker");
console.log("  - Autopilot Schedule Worker");
console.log("  - Listening Sync Worker");
console.log("  - Sentiment Analysis Worker");
console.log("  - Campaign Analytics Sync Worker");
console.log("  - Brand Content Sync Worker");
console.log("  - Outreach Send Worker");
console.log("  - Outreach Poll Worker");
console.log("  - Repurpose Video Worker");
console.log("  - Avatar Cache Worker");
console.log("  - Caption Fanout Worker");
console.log("  - Super Text Worker");
console.log("  - External Post Sync Worker");
console.log("  - Cron Jobs (token refresh: 30min, analytics: 6hr, agent runs: 1min, cleanup: 1hr, pipeline: 15min)");

// Graceful shutdown — BOUNDED DRAIN (2026-09-16).
// The 2026-09-15 deploy SIGKILLed 10 in-flight Instagram publishes after
// Docker's default 10s grace (an IG reel publish takes 80-120s); they then sat
// orphaned at PUBLISHING for 30 min. The worker service now has
// `stop_grace_period: 5m` (and NO init — see the compose comment), and this handler spends that window
// letting in-flight jobs finish: every worker.close() below stops fetching new
// jobs at once and resolves when its active jobs complete. The wait is capped
// at WORKER_SHUTDOWN_TIMEOUT_MS (default 270s, 30s inside the grace) so we exit
// — and log why — before Docker's SIGKILL. A second SIGTERM/SIGINT during the
// drain only logs (see lib/shutdown.ts).
//
// ⚠️ Crons are NOT stopped first: scheduler/cron-jobs.ts starts bare
// setInterval/setTimeout handles and exposes no stop function. During the drain
// they can still fire, but they only enqueue into Redis (picked up by the next
// container) or do the same in-process sweeps they always did, and compose
// stops this container before the replacement starts, so there is never a
// second cron leader.
const shutdown = createGracefulShutdown({
  timeoutMs: resolveShutdownTimeoutMs(),
  activePublishJobs: () => readActiveJobCount(postPublishWorker),
  awaitBackgroundTasks,
  pendingBackgroundTasks: pendingBackgroundTaskCount,
  markStopped: () => {
    // Mark all workers as stopped for health checks
    markWorkerStopped("post-publish");
    markWorkerStopped("token-refresh");
    markWorkerStopped("analytics-sync");
    markWorkerStopped("webhook-delivery");
    markWorkerStopped("media-process");
    markWorkerStopped("rss-sync");
    markWorkerStopped("agent-run");
    markWorkerStopped("trend-discover");
    markWorkerStopped("trend-score");
    markWorkerStopped("content-generate");
    markWorkerStopped("autopilot-schedule");
    markWorkerStopped("listening-sync");
    markWorkerStopped("sentiment-analysis");
    markWorkerStopped("campaign-analytics-sync");
    markWorkerStopped("brand-content-sync");
    markWorkerStopped("outreach-send");
    markWorkerStopped("outreach-poll");
    markWorkerStopped("repurpose-video");
    markWorkerStopped("avatar-cache");
    markWorkerStopped("caption-fanout");
    markWorkerStopped("super-text");
  },
  closeWorkers: () => {
    // ⚠️ LONG-RUNNING workers stop fetching but are NOT waited for. A
    // media-optimize transcode can run up to 60 min and a repurpose render for
    // many minutes; waiting on them would hold every deploy — with NO worker
    // publishing, since the replacement container only starts after this one
    // exits — for the full drain budget, only for Docker to kill them anyway.
    // Their jobs are re-run after the restart via BullMQ's stalled handling,
    // exactly as before this drain existed. Everything publish-related
    // (post-publish, super-text burns, caption fan-out) IS drained.
    for (const longRunning of [mediaOptimizeWorker, repurposeVideoWorker]) {
      longRunning.close().catch((err) => console.warn("[Shutdown] closing a long-running worker failed:", err?.message ?? err));
    }
    return Promise.all([
      postPublishWorker.close(),
      tokenRefreshWorker.close(),
      analyticsSyncWorker.close(),
      webhookDeliveryWorker.close(),
      mediaProcessWorker.close(),
      rssSyncWorker.close(),
      agentRunWorker.close(),
      trendDiscoverWorker.close(),
      trendScoreWorker.close(),
      contentGenerateWorker.close(),
      autopilotScheduleWorker.close(),
      listeningSyncWorker.close(),
      sentimentAnalysisWorker.close(),
      campaignAnalyticsSyncWorker.close(),
      brandContentSyncWorker.close(),
      outreachSendWorker.close(),
      outreachPollWorker.close(),
      avatarCacheWorker.close(),
      externalPostSyncWorker.close(),
      captionFanoutWorker.close(),
      superTextWorker.close(),
    ]);
  },
  closeHealthServer: () => healthServer.close(),
  exit: (code) => process.exit(code),
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Prevent orphan job errors or transient failures from killing the whole process
process.on("unhandledRejection", (reason: any, promise) => {
  console.error("[Worker] Unhandled rejection (process kept alive):", reason?.message ?? reason);
});
process.on("uncaughtException", (err) => {
  console.error("[Worker] Uncaught exception (process kept alive):", err?.message ?? err);
});
