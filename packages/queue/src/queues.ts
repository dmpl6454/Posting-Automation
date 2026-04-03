import { Queue, type DefaultJobOptions } from "bullmq";
import { redisConnection } from "./connection";
import type { PostPublishJobData, TokenRefreshJobData, AnalyticsSyncJobData, MediaProcessJobData, WebhookDeliveryJobData, RssSyncJobData, NotificationSendJobData, AgentRunJobData, TrendDiscoverJobData, TrendScoreJobData, ContentGenerateJobData, AutopilotScheduleJobData, ListeningSyncJobData, SentimentAnalysisJobData, CampaignAnalyticsSyncJobData, OutreachSendJobData, OutreachPollJobData } from "./types";

/** Default retry config: 3 attempts with exponential backoff (30s base) */
const DEFAULT_JOB_OPTS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 1000 },
};

function createQueue<T>(name: string): Queue<T> {
  return new Queue<T>(name, {
    connection: redisConnection,
    defaultJobOptions: DEFAULT_JOB_OPTS,
  });
}

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
  OUTREACH_SEND: "outreach-send",
  OUTREACH_POLL: "outreach-poll",
} as const;

export const postPublishQueue = createQueue<PostPublishJobData>(QUEUE_NAMES.POST_PUBLISH);
export const tokenRefreshQueue = createQueue<TokenRefreshJobData>(QUEUE_NAMES.TOKEN_REFRESH);
export const analyticsSyncQueue = createQueue<AnalyticsSyncJobData>(QUEUE_NAMES.ANALYTICS_SYNC);
export const mediaProcessQueue = createQueue<MediaProcessJobData>(QUEUE_NAMES.MEDIA_PROCESS);
export const webhookDeliveryQueue = createQueue<WebhookDeliveryJobData>(QUEUE_NAMES.WEBHOOK_DELIVERY);
export const rssSyncQueue = createQueue<RssSyncJobData>(QUEUE_NAMES.RSS_SYNC);
export const notificationSendQueue = createQueue<NotificationSendJobData>(QUEUE_NAMES.NOTIFICATION_SEND);
export const agentRunQueue = createQueue<AgentRunJobData>(QUEUE_NAMES.AGENT_RUN);
export const trendDiscoverQueue = createQueue<TrendDiscoverJobData>(QUEUE_NAMES.TREND_DISCOVER);
export const trendScoreQueue = createQueue<TrendScoreJobData>(QUEUE_NAMES.TREND_SCORE);
export const contentGenerateQueue = createQueue<ContentGenerateJobData>(QUEUE_NAMES.CONTENT_GENERATE);
export const autopilotScheduleQueue = createQueue<AutopilotScheduleJobData>(QUEUE_NAMES.AUTOPILOT_SCHEDULE);
export const listeningSyncQueue = createQueue<ListeningSyncJobData>(QUEUE_NAMES.LISTENING_SYNC);
export const sentimentAnalysisQueue = createQueue<SentimentAnalysisJobData>(QUEUE_NAMES.SENTIMENT_ANALYSIS);
export const campaignAnalyticsSyncQueue = createQueue<CampaignAnalyticsSyncJobData>(QUEUE_NAMES.CAMPAIGN_ANALYTICS_SYNC);
export const outreachSendQueue = createQueue<OutreachSendJobData>(QUEUE_NAMES.OUTREACH_SEND);
export const outreachPollQueue = createQueue<OutreachPollJobData>(QUEUE_NAMES.OUTREACH_POLL);
