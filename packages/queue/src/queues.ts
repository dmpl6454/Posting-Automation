import { Queue } from "bullmq";
import { redisConnection } from "./connection";
import type { PostPublishJobData, TokenRefreshJobData, AnalyticsSyncJobData, MediaProcessJobData, WebhookDeliveryJobData, RssSyncJobData, NotificationSendJobData, AgentRunJobData, TrendDiscoverJobData, TrendScoreJobData, ContentGenerateJobData, AutopilotScheduleJobData, ListeningSyncJobData, SentimentAnalysisJobData, CampaignAnalyticsSyncJobData } from "./types";

export const QUEUE_NAMES = {
  POST_PUBLISH: "post-publish",
  TOKEN_REFRESH: "token-refresh",
  ANALYTICS_SYNC: "analytics-sync",
  MEDIA_PROCESS: "media-process",
  WEBHOOK_DELIVERY: "webhook-delivery",
  RSS_SYNC: "rss-sync",
  NOTIFICATION_SEND: "notification-send",
  AGENT_RUN: "agent-run",
  TREND_DISCOVER: "trend-discover",
  TREND_SCORE: "trend-score",
  CONTENT_GENERATE: "content-generate",
  AUTOPILOT_SCHEDULE: "autopilot-schedule",
  LISTENING_SYNC: "listening-sync",
  SENTIMENT_ANALYSIS: "sentiment-analysis",
  CAMPAIGN_ANALYTICS_SYNC: "campaign-analytics-sync",
} as const;

export const postPublishQueue = new Queue<PostPublishJobData>(
  QUEUE_NAMES.POST_PUBLISH,
  { connection: redisConnection }
);

export const tokenRefreshQueue = new Queue<TokenRefreshJobData>(
  QUEUE_NAMES.TOKEN_REFRESH,
  { connection: redisConnection }
);

export const analyticsSyncQueue = new Queue<AnalyticsSyncJobData>(
  QUEUE_NAMES.ANALYTICS_SYNC,
  { connection: redisConnection }
);

export const mediaProcessQueue = new Queue<MediaProcessJobData>(
  QUEUE_NAMES.MEDIA_PROCESS,
  { connection: redisConnection }
);

export const webhookDeliveryQueue = new Queue<WebhookDeliveryJobData>(
  QUEUE_NAMES.WEBHOOK_DELIVERY,
  { connection: redisConnection }
);

export const rssSyncQueue = new Queue<RssSyncJobData>(
  QUEUE_NAMES.RSS_SYNC,
  { connection: redisConnection }
);

export const notificationSendQueue = new Queue<NotificationSendJobData>(
  QUEUE_NAMES.NOTIFICATION_SEND,
  { connection: redisConnection }
);

export const agentRunQueue = new Queue<AgentRunJobData>(
  QUEUE_NAMES.AGENT_RUN,
  { connection: redisConnection }
);

export const trendDiscoverQueue = new Queue<TrendDiscoverJobData>(
  QUEUE_NAMES.TREND_DISCOVER,
  { connection: redisConnection }
);

export const trendScoreQueue = new Queue<TrendScoreJobData>(
  QUEUE_NAMES.TREND_SCORE,
  { connection: redisConnection }
);

export const contentGenerateQueue = new Queue<ContentGenerateJobData>(
  QUEUE_NAMES.CONTENT_GENERATE,
  { connection: redisConnection }
);

export const autopilotScheduleQueue = new Queue<AutopilotScheduleJobData>(
  QUEUE_NAMES.AUTOPILOT_SCHEDULE,
  { connection: redisConnection }
);

export const listeningSyncQueue = new Queue<ListeningSyncJobData>(
  QUEUE_NAMES.LISTENING_SYNC,
  { connection: redisConnection }
);

export const sentimentAnalysisQueue = new Queue<SentimentAnalysisJobData>(
  QUEUE_NAMES.SENTIMENT_ANALYSIS,
  { connection: redisConnection }
);

export const campaignAnalyticsSyncQueue = new Queue<CampaignAnalyticsSyncJobData>(
  QUEUE_NAMES.CAMPAIGN_ANALYTICS_SYNC,
  { connection: redisConnection }
);
