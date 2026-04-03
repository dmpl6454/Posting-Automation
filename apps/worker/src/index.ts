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
import { startCronJobs } from "./scheduler/cron-jobs";
import { registerWorker, markWorkerStopped, startHealthServer } from "./lib/health";

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

// Start cron jobs
startCronJobs();

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
console.log("  - Cron Jobs (token refresh: 30min, analytics: 6hr, agent runs: 1min, cleanup: 1hr, pipeline: 15min)");

// Graceful shutdown
async function shutdown() {
  console.log("\nShutting down workers...");

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

  await Promise.all([
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
  ]);

  healthServer.close();
  console.log("Workers stopped. Exiting.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
