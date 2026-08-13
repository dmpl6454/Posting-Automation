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
  /**
   * The PipelineRun this job belongs to, when one exists.
   *
   * ⚠️ OPTIONAL ON PURPOSE — do NOT make this required again, and never satisfy it
   * with a synthesised value. Some producers legitimately have no pipeline run
   * behind them: `autopilot.router.approvePost` (a human clicking Approve) and the
   * auto-healer's retry sweep. The auto-healer used to paper over the required type
   * by inventing `autohealer-<timestamp>`, but `PipelineRun.id` is
   * `@default(cuid())` and nothing ever creates such a row — so every healed job
   * hit `pipelineRun.update({ where: { id: "autohealer-…" } })` and threw P2025
   * (~2/hour on prod, guaranteed rather than racy).
   *
   * Worse, a fabricated id DEFEATS the existence guards, which test truthiness:
   * `"autohealer-…"` sails through `if (pipelineRunId)` and throws AFTER the post
   * and its targets are already SCHEDULED, so the outer catch stamps the post
   * FAILED while it quietly publishes — verbatim the bug that guard was written to
   * prevent.
   *
   * ⚠️ Every consumer must guard on presence before querying. In particular
   * `updateMany({ where: { id: undefined } })` matches EVERY ROW in Prisma
   * (undefined means "no filter"), so an absent id without a guard is far more
   * dangerous than the throw it replaced.
   */
  pipelineRunId?: string;
}

export interface AutopilotScheduleJobData {
  autopilotPostId: string;
  organizationId: string;
  /** See ContentGenerateJobData.pipelineRunId — optional, never synthesised. */
  pipelineRunId?: string;
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
export interface MediaOptimizeJobData {
  mediaId: string;
}

export interface AvatarCacheJobData {
  channelId: string;
}

/**
 * PR-5 (per-channel unique captions): generate one DISTINCT AI caption per
 * pending PostTarget (written to PostTarget.contentOverride), then flip the
 * post DRAFT→SCHEDULED so the publish cron picks it up. ONE job per post —
 * enqueued with jobId `caption-fanout-{postId}` so re-submits dedupe.
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

/**
 * Super text burn: ONE job per post. The worker renders each configured video's
 * text strip to a transparent PNG, composites it with ffmpeg, creates a DERIVED
 * Media row, repoints the post's PostMedia at it, then flips the parked
 * DRAFT→SCHEDULED once no other gate remains.
 */
export interface SuperTextBurnJobData {
  postId: string;
  organizationId: string;
}

/**
 * Ingest the posts that exist ON a connected account — including ones published
 * directly on the platform, which Insights could never see before.
 *
 * Keyed by ACCOUNT (platform + platformId), NOT by channel row. The same Page/IG
 * account legitimately exists in many orgs (Channel is unique per
 * [organizationId, platform, platformId]), so 1339 prod channel rows collapse to 524
 * distinct accounts. One Graph call per account is then fanned out to every channel
 * row sharing it — the optimization that keeps this cheap under concurrent user load.
 */
export interface ExternalPostSyncJobData {
  platform: string;
  platformId: string;
  /** Candidate channel ids, best token FIRST (see external-sync-accounts.ts). */
  candidateChannelIds: string[];
  /** Every channel row for this account — the fan-out targets for fetched posts. */
  targetChannelIds: string[];
  /** Hard floor for the sync window; never list posts older than this. */
  since: string;
}
