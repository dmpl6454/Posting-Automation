import { Queue } from "bullmq";
import { redisConnection } from "./connection";
import type { PostPublishJobData, TokenRefreshJobData, AnalyticsSyncJobData, MediaProcessJobData, WebhookDeliveryJobData, RssSyncJobData, NotificationSendJobData } from "./types";

export const QUEUE_NAMES = {
  POST_PUBLISH: "post-publish",
  TOKEN_REFRESH: "token-refresh",
  ANALYTICS_SYNC: "analytics-sync",
  MEDIA_PROCESS: "media-process",
  WEBHOOK_DELIVERY: "webhook-delivery",
  RSS_SYNC: "rss-sync",
  NOTIFICATION_SEND: "notification-send",
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
