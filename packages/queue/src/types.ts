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

export interface TrendDiscoverJobData {
  organizationId: string;
  pipelineRunId: string;
}

export interface TrendScoreJobData {
  trendingItemId: string;
  organizationId: string;
  pipelineRunId: string;
}

export interface ContentGenerateJobData {
  autopilotPostId: string;
  organizationId: string;
  pipelineRunId: string;
}

export interface AutopilotScheduleJobData {
  autopilotPostId: string;
  organizationId: string;
  pipelineRunId: string;
}

export interface ListeningSyncJobData {
  listeningQueryId: string;
  organizationId: string;
}

export interface SentimentAnalysisJobData {
  mentionId: string;
  content: string;
}

export interface CampaignAnalyticsSyncJobData {
  campaignId: string;
  organizationId: string;
}

export interface OutreachSendJobData {
  messageId: string;
  leadId: string;
}

export interface OutreachPollJobData {
  organizationId: string;
}
