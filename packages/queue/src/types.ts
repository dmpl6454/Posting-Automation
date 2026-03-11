export interface PostPublishJobData {
  postId: string;
  postTargetId: string;
  channelId: string;
  platform: string;
  organizationId: string;
}

export interface TokenRefreshJobData {
  channelId: string;
  platform: string;
}

export interface AnalyticsSyncJobData {
  postTargetId: string;
  platform: string;
  channelId: string;
  platformPostId: string;
}

export interface MediaProcessJobData {
  mediaId: string;
  organizationId: string;
  operation: "thumbnail" | "resize" | "optimize";
}

export interface WebhookDeliveryJobData {
  webhookDeliveryId: string;
  webhookId: string;
  url: string;
  secret: string;
  event: string;
  payload: Record<string, unknown>;
}

export interface RssSyncJobData {
  feedId: string;
  organizationId: string;
}

export interface NotificationSendJobData {
  notificationId: string;
  userId: string;
  organizationId: string;
  type: string;
}

export interface AgentRunJobData {
  agentId: string;
  organizationId: string;
}
