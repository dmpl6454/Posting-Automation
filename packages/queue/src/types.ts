export interface PostPublishJobData {
  postId: string;
  postTargetId: string;
  channelId: string;
  platform: string;
  organizationId: string;
  /**
   * Phase 2 exact-time scheduling: the post's scheduledAt (epoch ms) as it
   * stood when this job was enqueued (schedule-publish.ts). Set ONLY on
   * schedule-path jobs; the publish worker skips (WITHOUT claiming) when the
   * post's current scheduledAt no longer matches — a rescheduled/unscheduled
   * post must never publish at its OLD time. Interactive publishNow/chat/
   * newsgrid jobs leave this unset and are never guarded.
   */
  enqueuedFor?: number;
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
  /**
   * At-age metric checkpoint tag ("24h" | "7d" | "15d" | "30d"). Set only by the
   * delayed jobs enqueued at publish time (post-publish.worker.ts) — the
   * resulting AnalyticsSnapshot gets metadata.windowTag so Insights → Reports
   * "at publish-age" mode can pin metrics as they stood exactly N after publish.
   */
  windowTag?: string;
  /**
   * Set by the daily reconciliation sweep (cron-jobs.ts) when a checkpoint was
   * missed and re-captured late — stamped into AnalyticsSnapshot.metadata so
   * Reports consumers can tell an exact-at-age capture from a late one.
   */
  capturedLate?: boolean;
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

export interface BrandContentSyncJobData {
  organizationId: string;
  campaignId?: string;
}

export interface OutreachSendJobData {
  messageId: string;
  leadId: string;
}

export interface OutreachPollJobData {
  organizationId: string;
}

/**
 * Re-cache a channel's profile picture to durable S3 storage. Platform CDN
 * avatar URLs captured at connect expire (IG/FB signed URLs) — the worker
 * resolves a fresh URL, downloads it, and rewrites Channel.avatar to a stable
 * S3 public URL (avatars/{orgId}/{channelId}.{ext}).
 */
export interface AvatarCacheJobData {
  channelId: string;
}

/**
 * PR-5 (per-channel unique captions): generate one DISTINCT AI caption per
 * pending PostTarget (written to PostTarget.contentOverride), then flip the
 * post DRAFT→SCHEDULED so the publish cron picks it up. ONE job per post —
 * enqueued with jobId `caption-fanout:{postId}` so re-submits dedupe.
 */
export interface CaptionFanoutJobData {
  postId: string;
  organizationId: string;
}

/**
 * Job data for offloading Content Studio video generation to the worker.
 *
 * The worker re-runs the heavy reel-stitch / Seedance generation, uploads the
 * result to S3, and publishes progress + the final media to the userId-scoped
 * progress channel (`progress:{progressId}`) the repurpose UI subscribes to.
 *
 * Field mapping:
 * - `reel`  → `generateReelVideo` (ReelOptions): worker downloads `slideUrls`
 *   → base64 `slideImages`; `voiceOver`/`bgMusic`/`voiceType`/`voiceScript`
 *   drive TTS + background music before stitching.
 * - `seedance` → `buildSeedancePrompt` + `generateSeedanceVideo`
 *   (SeedanceGenerateParams): `scenes` = key points, `title`/`description`
 *   = content brief, `duration` = clip length in seconds.
 */
export interface RepurposeVideoJobData {
  userId: string;
  organizationId: string;
  /**
   * RAW client progress id (e.g. `rep-<ts>-<6char>`) — NOT pre-scoped.
   * The producer enqueues `input.progressId` verbatim; the worker scopes it
   * EXACTLY ONCE via `scopedProgressId(userId, progressId)` so the resulting
   * key matches the SSE reader (apps/web/app/api/progress/route.ts), which also
   * scopes the raw `rep-` id a single time. Do NOT pass a pre-scoped id here or
   * the worker would double-scope (`userId:userId:rep-...`) and never match.
   */
  progressId: string;
  format: "reel" | "seedance_video";
  theme: "dark" | "light" | "gradient";
  reel?: {
    slideUrls: string[];
    voiceOver: boolean;
    bgMusic: boolean;
    voiceType?: string;
    voiceScript?: string;
  };
  seedance?: {
    scenes: string[];
    title: string;
    description: string;
    duration: number;
  };
}
