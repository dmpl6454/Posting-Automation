import { Worker, type Job, UnrecoverableError } from "bullmq";
import { prisma } from "@postautomation/db";
import {
  getSocialProvider,
  isAmbiguousPublishError,
  resolvePlatformCredentials,
} from "@postautomation/social";
import { QUEUE_NAMES, postPublishQueue, analyticsSyncQueue, type PostPublishJobData, createRedisConnection } from "@postautomation/queue";
import IORedis from "ioredis";
import { buildPublishEmail, buildPublishReportCsv } from "../lib/publish-email";
import { planFacebookAnalyticsId, earlyVideoSyncDelayMs } from "../lib/fb-video-post-id";
import { addLocalClaim, releaseLocalClaim, localClaimCount } from "../lib/local-claims";
import { trackBackgroundTask } from "../lib/background-tasks";
import { createDispatchPacer } from "../lib/dispatch-pacer";
import { markTargetFailed, markTargetAmbiguous, buildPublishClaimWhere, routePublishError, shouldPreflightReconcile, buildPublishNotifications, mediaRequiredReason, isSeedNoise, isStaleScheduleJob, isHeavyPublish, planHeavyDefer, HEAVY_SLOT_WAIT_MESSAGE, OPTIMIZE_WAIT_MESSAGE, classifyError, isDefiniteAuthFailure, releaseClaimAfterPrePublishError, decideClaimMiss, countOtherActiveJobsForTarget, ORPHANED_CLAIM_MESSAGE, ORPHANED_CLAIM_UNKNOWN_OUTCOME_MESSAGE, FINAL_ATTEMPT_ORPHAN_MESSAGE, formatPublishTiming, type PublishJobState } from "../lib/publish-recovery";
import { PRIORITY_RETRY, mediaOptimizeQueue, atAgeWindowsForFormat, resolvePlatformStaggerMs } from "@postautomation/queue";
import { planOptimizeGate, choosePublishUrl } from "../lib/media-optimize";
import { buildSnapshotMetadata } from "../lib/snapshot-metadata";

/**
 * How far back a PRE-FLIGHT reconciliation looks when a retry is about to
 * re-publish. Bounded so the listing stays cheap and so a genuinely different
 * post that happens to share a caption cannot be adopted from weeks ago.
 */
const PREFLIGHT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Integer env knob with a default and a sane clamp (bad values → default). */
function envInt(name: string, def: number, min: number, max: number): number {
  const parsed = parseInt(process.env[name] ?? "", 10);
  if (Number.isNaN(parsed)) return def;
  return Math.min(max, Math.max(min, parsed));
}

// Publishing is network-I/O-bound (platform API calls + media uploads), so a
// single Node process handles well above 3 concurrent publishes. Per-platform
// protection does NOT live here — it's the per-platform stagger
// (@postautomation/queue publish-stagger) + the reactive rate_limit reclassification below +
// the FB provider's own throttle backoff. This limiter is only a global safety
// valve; at 3/5s it was the cross-tenant choke point (36 starts/min for the
// whole platform, and three slow FB/YouTube jobs froze publishing for
// every org).
const PUBLISH_CONCURRENCY = envInt("PUBLISH_CONCURRENCY", 10, 1, 25);
const PUBLISH_LIMITER_MAX = envInt("PUBLISH_LIMITER_MAX", 10, 1, 50);

// Above this, the IG/FB ffmpeg watermark pass (download → re-encode → re-upload
// in /tmp) is skipped and the original video is posted as-is — a multi-GB
// re-encode on the shared worker would exhaust disk/CPU and stall the queue.
// Env-tunable; 250MB comfortably covers normal branded videos.
const OVERLAY_MAX_BYTES = (() => {
  const mb = parseInt(process.env.VIDEO_OVERLAY_MAX_MB ?? "", 10);
  return (Number.isFinite(mb) && mb > 0 ? mb : 250) * 1024 * 1024;
})();

// Heavy-media publish cap: a streamed multi-GB upload (YouTube resumable, X
// chunked APPENDs, LinkedIn instruction PUTs) holds its concurrency slot for
// the ENTIRE serial chunk loop — minutes to an hour. Unbounded, ten such jobs
// occupy every slot and a one-line interactive tweet waits tens of minutes
// behind them (fast-lane ordering only governs which WAITING job starts next;
// it cannot preempt running jobs). Excess heavy jobs are DEFERRED via the
// rate-limit re-queue pattern, never blocked in-process (a blocking wait would
// hold the slot anyway and trip the 45-min watchdog). IG/FB/TikTok/Threads are
// URL-pull (the platform fetches media itself) and deliberately exempt.
// Per-process counter — single worker container today; if extra replicas ever
// ship (CRON_LEADER=false processors), each gets its own cap: still bounded.
// Outer Math.min: envInt returns the DEFAULT unclamped when the env var is
// unset, so clamp again — the cap must stay < PUBLISH_CONCURRENCY.
const HEAVY_MEDIA_CONCURRENCY = Math.min(
  envInt("HEAVY_MEDIA_CONCURRENCY", 3, 1, 24),
  Math.max(1, PUBLISH_CONCURRENCY - 1)
);
const HEAVY_MEDIA_THRESHOLD_BYTES = envInt("HEAVY_MEDIA_THRESHOLD_MB", 300, 1, 4096) * 1024 * 1024;
const HEAVY_STREAM_PLATFORMS = new Set(["YOUTUBE", "TWITTER", "LINKEDIN"]);
let heavyActive = 0;

// Process-local claim registry: ../lib/local-claims (shared with the
// stuck-PUBLISHING reaper in auto-healer.worker.ts).

// Same-post Meta dispatch pacing (2026-09-16) — see lib/dispatch-pacer.ts. The
// shared normalize encode releases every target that waited on it in the same
// tick; this restores the per-platform spacing between their publish calls.
const dispatchPacer = createDispatchPacer();
const PACED_DISPATCH_PLATFORMS = new Set(["INSTAGRAM", "FACEBOOK"]);

// Redis pub/sub publisher for upload progress SSE
const progressPublisher = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

/** Persist + broadcast upload progress (0-100) for a PostTarget */
async function reportProgress(postTargetId: string, percent: number): Promise<void> {
  try {
    await prisma.postTarget.update({
      where: { id: postTargetId },
      data: { uploadProgress: percent },
    });
    await progressPublisher.publish(`progress-notify:${postTargetId}`, JSON.stringify({ percent }));
  } catch {
    // Non-fatal — progress reporting should never block publishing
  }
}

// ── Email report after all targets complete ────────────────────────────
// Redesign 2026-07-17 (owner decision): sent to the POST CREATOR only (was:
// every org OWNER/ADMIN — noisy). Since 2026-09-15 the body is the live post
// links only, one per line; platform, channel, handle and UTC+IST time ride in
// the attached CSV. Template lives in ../lib/publish-email.ts (pure +
// unit-tested, HTML-escaped — the old inline template interpolated user
// content raw).
async function sendPublishReportEmail(
  organizationId: string,
  postId: string,
  postContent: string,
  allTargets: {
    status: string;
    publishedUrl: string | null;
    publishedAt: Date | null;
    ambiguousAt: Date | null;
    channel: { platform: string; name: string; username: string | null };
  }[]
) {
  try {
    // Recipient: the post creator. Fall back to org OWNERs only if the post has
    // no resolvable creator (e.g. system-created autopilot orphans).
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { createdById: true },
    });
    let recipients: { email: string | null }[] = [];
    if (post?.createdById) {
      const creator = await prisma.user.findUnique({
        where: { id: post.createdById },
        select: { email: true },
      });
      if (creator?.email) recipients = [creator];
    }
    if (recipients.length === 0) {
      const owners = await prisma.organizationMember.findMany({
        where: { organizationId, role: "OWNER" },
        include: { user: { select: { email: true } } },
      });
      recipients = owners.map((m) => m.user);
      console.warn(
        `[PostPublish] post ${postId} has no resolvable creator email — falling back to ${recipients.length} org owner(s)`
      );
    }
    if (recipients.length === 0) return;

    const emailInput = {
      postId,
      postContent,
      appUrl: process.env.APP_URL || "http://localhost:3000",
      targets: allTargets.map((t) => ({
        platform: t.channel.platform,
        channelName: t.channel.name,
        channelUsername: t.channel.username,
        status: t.status,
        publishedUrl: t.publishedUrl,
        publishedAt: t.publishedAt,
        // Outcome unknown (may already be live) — the email must not call it failed.
        ambiguous: t.ambiguousAt != null,
      })),
    };
    const { subject, html, text } = buildPublishEmail(emailInput);

    // Spreadsheet-ready CSV attachment (platform, channel, url, …) so the
    // recipient gets the links into Sheets/Excel in one click. Built in its
    // own try/catch: a CSV failure must never block the email itself, just
    // as an email failure never blocks the publish.
    let attachments:
      | { filename: string; content: string; contentType: string }[]
      | undefined;
    try {
      const csv = buildPublishReportCsv(emailInput);
      attachments = [
        {
          filename: `publish-report-${postId}.csv`,
          // BOM prefix so Excel detects UTF-8 (same as apps/web/lib/csv.ts).
          content: "﻿" + csv,
          contentType: "text/csv; charset=utf-8",
        },
      ];
    } catch (csvErr: any) {
      console.warn(`[PostPublish] publish-report CSV build failed (email sent without attachment):`, csvErr.message);
    }

    // Send via nodemailer (same SMTP config as the API package)
    let transport: any = null;
    if (process.env.SMTP_HOST) {
      try {
        const nodemailer = require("nodemailer");
        transport = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT || "587"),
          secure: process.env.SMTP_SECURE === "true",
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
      } catch { /* nodemailer not available */ }
    }

    const from = process.env.SMTP_FROM || "PostAutomation <noreply@postautomation.app>";

    for (const r of recipients) {
      if (!r.email) continue;
      if (transport) {
        await transport.sendMail({ from, to: r.email, subject, html, text, attachments });
        console.log(`[PostPublish] Publish email sent to ${r.email}`);
      } else {
        console.log(`[PostPublish] [Email Preview] To: ${r.email} | Subject: ${subject}`);
      }
    }
  } catch (emailErr: any) {
    // Never let email failure break the publish flow
    console.warn(`[PostPublish] Email report failed:`, emailErr.message);
  }
}

// ── In-app notifications (best-effort) ───────────────────────────────────
// Writes one Notification row per org owner/admin for a publish outcome so the
// Activity panel's SSE/unread-driven refresh fires on publish events. Reuses the
// same OWNER/ADMIN lookup as the email report. MUST never throw — a notification
// failure can never be allowed to fail the publish.
async function notifyPublishOutcome(
  organizationId: string,
  postId: string,
  postTargetId: string,
  platform: string,
  status: "PUBLISHED" | "FAILED"
): Promise<void> {
  try {
    const members = await prisma.organizationMember.findMany({
      where: { organizationId, role: { in: ["OWNER", "ADMIN"] } },
      select: { userId: true },
    });
    const rows = buildPublishNotifications(
      members.map((m) => m.userId),
      { organizationId, postId, postTargetId, platform, status }
    );
    for (const row of rows) {
      await prisma.notification.create({ data: row });
    }
  } catch (notifyErr: any) {
    console.warn(`[PostPublish] Notification write failed for ${postTargetId}:`, notifyErr?.message);
  }
}

// ── Platform character limits ───────────────────────────────────────────
const PLATFORM_CHAR_LIMITS: Record<string, number> = {
  TWITTER: 280,
  INSTAGRAM: 2200,
  FACEBOOK: 63206,
  LINKEDIN: 3000,
  THREADS: 500,
  TIKTOK: 2200,
  PINTEREST: 500,
  MASTODON: 500,
  BLUESKY: 300,
  REDDIT: 40000,
  YOUTUBE: 5000,
  MEDIUM: 100000,
  DEVTO: 100000,
  WORDPRESS: 100000,
};

// ── Error classification ────────────────────────────────────────────────
// classifyError lives in ../lib/publish-recovery (moved 2026-09-16 so it is
// unit-testable without importing this module, which opens Redis at load).

// ── Auto-truncate content for platform ──────────────────────────────────
function truncateForPlatform(content: string, platform: string): string {
  const limit = PLATFORM_CHAR_LIMITS[platform];
  if (!limit || content.length <= limit) return content;
  // Truncate at last space before limit, add ellipsis
  const cut = content.slice(0, limit - 3);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > limit * 0.7 ? cut.slice(0, lastSpace) : cut) + "...";
}

export function createPostPublishWorker() {
  // The publish processor. Named (2026-09-16) so the Worker below can wrap it
  // in the pre-publish claim guard. ⚠️ Its body is deliberately left at its
  // ORIGINAL indentation (two spaces deeper than this declaration) so the
  // ~900-line function did not have to be re-indented — a re-indent would bury
  // the real changes in whitespace noise on the most sensitive file we have.
  const processPublishJob = async (job: Job<PostPublishJobData>, state: PublishJobState) => {
      const { postTargetId, channelId, platform } = job.data;
      console.log(`[PostPublish] Processing job ${job.id} for target ${postTargetId} (attempt ${job.attemptsMade + 1})`);

      // Phase 2 exact-time guard — schedule-path jobs only (enqueuedFor set).
      // A rescheduled/unscheduled post keeps its target ids, so this job may
      // be an orphan of the OLD schedule; skip WITHOUT claiming when the
      // post's current scheduledAt no longer matches the enqueue snapshot
      // (the new schedule has its own sched:{targetId}:{epoch} jobs).
      // Interactive publishNow/chat/newsgrid/agent jobs carry no enqueuedFor
      // and are never guarded.
      if (job.data.enqueuedFor != null) {
        const schedPost = await prisma.post.findUnique({
          where: { id: job.data.postId },
          select: { scheduledAt: true },
        });
        if (isStaleScheduleJob(job.data.enqueuedFor, schedPost?.scheduledAt ?? null)) {
          console.log(`[PostPublish] Skipping stale schedule job ${job.id} for ${postTargetId} (post rescheduled/unscheduled/deleted)`);
          return;
        }
      }

      // 0. Atomic idempotency claim — only transitions SCHEDULED/FAILED/DRAFT → PUBLISHING.
      // If the target is already PUBLISHING/PUBLISHED or doesn't exist, skip silently.
      // ⚠️ buildPublishClaimWhere adds `ambiguousAt: null`. A target whose publish
      // outcome could not be determined is deliberately UNCLAIMABLE, so no retry
      // layer can re-run a create that may already have succeeded. See
      // PostTarget.ambiguousAt and the 2026-08-13 incident.
      const claim = await prisma.postTarget.updateMany({
        where: buildPublishClaimWhere(postTargetId),
        data: { status: "PUBLISHING" },
      });
      if (claim.count === 0) {
        // The claim guard only transitions SCHEDULED/FAILED/DRAFT → PUBLISHING.
        // count===0 means the target is already PUBLISHING/PUBLISHED or gone.
        //
        // ── Claim-miss handling (reworked 2026-09-16) ────────────────────────
        // A target left at PUBLISHING by a job that is no longer running (the
        // 2026-09-15 deploy SIGKILLed 10 in-flight publishes) used to be
        // skipped here and sat for 30 min until the reaper. It is now handled
        // on POSITIVE evidence that no job holds it (BullMQ's active list plus
        // this process's own claims) — see decideClaimMiss:
        //   - another holder exists → skip (that job owns the terminal write),
        //     on the final attempt too;
        //   - Instagram/Facebook → release and retry through the duplicate
        //     pre-flight (non-final) or fail it retryably (final);
        //   - any other platform → the dead holder may already have published
        //     and nothing can check, so park it as ambiguous for a person
        //     rather than risk an automatic duplicate.
        // Every write is conditional on the exact row inspected, and any error
        // in the check falls back to a skip (the reaper is the backstop).
        const isFinalAttempt = (job.attemptsMade + 1) >= (job.opts?.attempts ?? 1);
        let outcome: "skip" | "retry" | "terminal" = "skip";
        let terminalMessage = "";
        try {
          const current = await prisma.postTarget.findUnique({
            where: { id: postTargetId },
            select: { status: true, publishedId: true, updatedAt: true },
          });
          let otherActiveJobs: number | null = null;
          let providerSupportsReconcile = false;
          if (current && current.status === "PUBLISHING" && !current.publishedId) {
            try {
              providerSupportsReconcile =
                typeof getSocialProvider(platform as any).findExistingPost === "function";
            } catch {
              providerSupportsReconcile = false;
            }
            try {
              const active = await postPublishQueue.getActive();
              otherActiveJobs = countOtherActiveJobsForTarget(
                active as Array<{ id?: string | null; data?: { postTargetId?: unknown } | null } | undefined>,
                job.id,
                postTargetId,
                localClaimCount(postTargetId),
              );
            } catch (activeErr: any) {
              console.warn(`[PostPublish] active-job lookup failed for ${postTargetId}: ${activeErr?.message}`);
              otherActiveJobs = null;
            }
          }
          const decision = decideClaimMiss({
            isFinalAttempt,
            status: current?.status ?? null,
            hasPublishedId: !!current?.publishedId,
            otherActiveJobs,
            providerSupportsReconcile,
          });
          // ⚠️ Conditional on the exact row we inspected: any write since (a
          // finishing holder, a progress tick, a platform id) bumps updatedAt
          // and makes each write below a no-op.
          const sameRow = current
            ? { id: postTargetId, status: "PUBLISHING" as const, publishedId: null, updatedAt: current.updatedAt }
            : null;
          if (decision === "recover-orphan" && sameRow) {
            const released = await prisma.postTarget.updateMany({
              where: sameRow,
              data: { status: "FAILED", errorMessage: ORPHANED_CLAIM_MESSAGE },
            });
            if (released.count === 1) outcome = "retry";
          } else if (decision === "park-orphan" && sameRow) {
            const parked = await prisma.postTarget.updateMany({
              where: sameRow,
              data: {
                status: "FAILED",
                errorMessage: ORPHANED_CLAIM_UNKNOWN_OUTCOME_MESSAGE,
                ambiguousAt: new Date(),
                ambiguousReason: ORPHANED_CLAIM_UNKNOWN_OUTCOME_MESSAGE,
              },
            });
            if (parked.count === 1) {
              outcome = "terminal";
              terminalMessage = ORPHANED_CLAIM_UNKNOWN_OUTCOME_MESSAGE;
            }
          } else if (decision === "terminalize" && sameRow) {
            const failed = await prisma.postTarget.updateMany({
              where: sameRow,
              data: { status: "FAILED", errorMessage: FINAL_ATTEMPT_ORPHAN_MESSAGE },
            });
            if (failed.count === 1) {
              outcome = "terminal";
              terminalMessage = FINAL_ATTEMPT_ORPHAN_MESSAGE;
            }
          }
        } catch (recoverErr: any) {
          console.warn(`[PostPublish] orphan-claim check failed for ${postTargetId} — skipping: ${recoverErr?.message}`);
        }
        if (outcome === "retry") {
          console.warn(`[PostPublish] target ${postTargetId} was orphaned at PUBLISHING (no job holds it) — released to FAILED; failing job ${job.id} so BullMQ retries with the duplicate pre-flight`);
          throw new Error(ORPHANED_CLAIM_MESSAGE);
        }
        if (outcome === "terminal") {
          // UnrecoverableError so worker.on("failed") finalizes the target,
          // increments retryCount (a later human Retry then runs the duplicate
          // pre-flight where one exists), notifies, and settles the parent post.
          console.warn(`[PostPublish] target ${postTargetId} orphaned at PUBLISHING (no job holds it) — marked terminal (job ${job.id}): ${terminalMessage}`);
          throw new UnrecoverableError(terminalMessage);
        }
        console.warn(`[PostPublish] target ${postTargetId} already claimed or published — skipping duplicate job ${job.id}`);
        return;
      }
      // This job now owns the claim. Recorded for the pre-publish guard in the
      // Worker wrapper and for the orphan check above.
      state.claimed = true;
      addLocalClaim(postTargetId);

      // 2. Get channel and post data — scope channel to the job's org (defense-in-depth)
      const [channel, postTarget] = await Promise.all([
        prisma.channel.findFirst({ where: { id: channelId, organizationId: job.data.organizationId } }),
        prisma.postTarget.findUniqueOrThrow({
          where: { id: postTargetId },
          include: {
            post: {
              include: { mediaAttachments: { include: { media: true }, orderBy: { order: "asc" } } },
            },
          },
        }),
      ]);

      // 2b. publishedId short-circuit — if already published in a previous attempt, skip provider call
      if (postTarget.publishedId) {
        console.log(`[PostPublish] target ${postTargetId} already has publishedId ${postTarget.publishedId} — marking PUBLISHED, skipping re-publish`);
        await prisma.postTarget.update({
          where: { id: postTargetId },
          data: { status: "PUBLISHED" },
        });
        return;
      }

      // 3a. Guard: channel not found or belongs to wrong org
      if (!channel) {
        console.warn(`[PostPublish] Channel ${channelId} not found for org ${job.data.organizationId} — skipping`);
        await prisma.postTarget.update({
          where: { id: postTargetId },
          data: { status: "FAILED", errorMessage: "Channel not found for this organization." },
        });
        return;
      }

      // 3b. Guard: skip publishing to inactive channels
      if (!channel.isActive) {
        console.warn(`[PostPublish] Channel ${channelId} (${platform}) is inactive — skipping publish`);
        await prisma.postTarget.update({
          where: { id: postTargetId },
          data: { status: "FAILED", errorMessage: "Channel is inactive. Re-enable it in the Channels page to publish." },
        });
        return;
      }

      // 3. Get provider and check token expiry
      const provider = getSocialProvider(platform as any);
      let accessToken = channel.accessToken;

      // Pre-publish token freshness check — refresh if expiring within 5 minutes
      if (channel.tokenExpiresAt && channel.refreshToken) {
        const expiresAt = new Date(channel.tokenExpiresAt);
        const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
        if (expiresAt < fiveMinutesFromNow) {
          console.log(`[PostPublish] Token for channel ${channelId} expiring soon, attempting refresh`);
          try {
            // Meta tokens can only be refreshed by the app that minted them —
            // resolve from channel.metaAppId (NULL = legacy pair). Non-Meta
            // platforms keep the identical env read.
            const creds = resolvePlatformCredentials(platform, channel.metaAppId);
            const clientId = creds?.clientId || "";
            const clientSecret = creds?.clientSecret || "";
            if (clientId && clientSecret) {
              const refreshed = await provider.refreshAccessToken(
                channel.refreshToken!,
              {
                clientId,
                clientSecret,
                callbackUrl: `${process.env.APP_URL || ""}/api/oauth/callback/${platform.toLowerCase()}`,
                scopes: [],
              });
              // Update DB with refreshed token
              await prisma.channel.update({
                where: { id: channelId },
                data: {
                  accessToken: refreshed.accessToken,
                  refreshToken: refreshed.refreshToken ?? channel.refreshToken,
                  tokenExpiresAt: refreshed.expiresAt ? new Date(refreshed.expiresAt) : undefined,
                },
              });
              accessToken = refreshed.accessToken;
              console.log(`[PostPublish] Token refreshed for channel ${channelId}`);
            } else {
              console.warn(`[PostPublish] Missing ${platform}_CLIENT_ID or ${platform}_CLIENT_SECRET, cannot refresh token`);
            }
          } catch (refreshErr: any) {
            console.error(`[PostPublish] Token refresh failed for channel ${channelId}:`, refreshErr.message);
            // Continue with existing token — it may still work
          }
        }
      }

      const tokens = {
        accessToken,
        refreshToken: channel.refreshToken ?? undefined,
      };

      // Use platform-specific content variant if available.
      // PR-5: a per-target caption override (unique captions) wins over both the
      // platform variant and the shared content. NULL contentOverride (every
      // pre-PR-5 post) short-circuits to the exact pre-existing expression.
      const contentVariants = postTarget.post.contentVariants as Record<string, string> | null;
      const content = postTarget.contentOverride ?? contentVariants?.[platform] ?? postTarget.post.content;
      // Platform-spec gate + rendition preference (IG/FB URL-pull): a >1GB
      // video is GUARANTEED to fail Instagram's server-side pull (hard 1GB
      // cap — live-verified error 2207076, 6/6 attempts). Wait for the
      // media-optimize rendition instead of burning minutes on a doomed
      // publish. Videos ≤950MB pass straight through (zero regression) and
      // merely PREFER the rendition when one exists.
      const gateMedia = postTarget.post.mediaAttachments.map((m) => ({
        id: m.media.id,
        url: m.media.url,
        fileType: m.media.fileType,
        fileSize: Number(m.media.fileSize ?? 0),
        metadata: (m.media as { metadata?: unknown }).metadata,
      }));
      const optimizeGate = planOptimizeGate({ platform, media: gateMedia, now: Date.now() });
      if (optimizeGate.action === "fail") {
        // Deterministic (the rendition failed, or its wait ceiling passed) —
        // retrying this job cannot change it. Terminal with the REAL reason; a
        // plain throw here used to orphan the target at PUBLISHING (2026-09-16).
        await markTargetFailed(prisma, postTargetId, optimizeGate.message);
        throw new UnrecoverableError(optimizeGate.message);
      }
      if (optimizeGate.action === "wait") {
        // Self-heal: (re)enqueue the rendition job (jobId dedupes with the
        // upload-time producer) and stamp the wait-ceiling clock for rows
        // that predate the pipeline.
        try {
          const waiting = gateMedia.find((m) => m.id === optimizeGate.mediaId);
          const meta = (waiting?.metadata ?? {}) as Record<string, unknown>;
          if (waiting && !meta.optimize) {
            await prisma.media.update({
              where: { id: waiting.id },
              data: { metadata: { ...meta, optimize: { status: "pending", enqueuedAt: new Date().toISOString() } } as any },
            });
          }
          await mediaOptimizeQueue.add(
            "optimize",
            { mediaId: optimizeGate.mediaId },
            { jobId: `optimize:${optimizeGate.mediaId}:v1`, attempts: 2, backoff: { type: "exponential", delay: 60_000 }, removeOnComplete: { age: 3600 }, removeOnFail: { age: 24 * 3600 } }
          );
        } catch (e) {
          console.warn(`[PostPublish] optimize enqueue failed for ${optimizeGate.mediaId}`, e);
        }
        const optimizeDelayMs = 90_000 + Math.floor(Math.random() * 60_000);
        console.log(
          `[PostPublish] Waiting for media optimization (${optimizeGate.mediaId}) — deferring ${postTargetId} ${Math.round(optimizeDelayMs / 1000)}s`
        );
        // ⚠️ RELEASE THE CLAIM FIRST, then enqueue (2026-09-16). The old order
        // (add, then update) left the target at PUBLISHING whenever the update
        // failed — and the delayed job then lost the claim and skipped it. Now a
        // failed add simply propagates: the target is already SCHEDULED, so
        // BullMQ's retry of THIS job can claim it again.
        await prisma.postTarget.update({
          where: { id: postTargetId },
          // OPTIMIZE_WAIT_MESSAGE is a watchdog keep-alive marker like
          // HEAVY_SLOT_WAIT_MESSAGE — defer-parked targets stay live.
          data: { status: "SCHEDULED", errorMessage: OPTIMIZE_WAIT_MESSAGE },
        });
        await postPublishQueue.add(`retry-optimize-${postTargetId}-${Date.now()}`, job.data, {
          delay: optimizeDelayMs,
          priority: PRIORITY_RETRY,
          attempts: 3,
          backoff: { type: "exponential", delay: 60_000 },
        });
        return;
      }
      let mediaUrls = postTarget.post.mediaAttachments.map((m) =>
        choosePublishUrl(platform, {
          url: m.media.url,
          fileType: m.media.fileType,
          fileSize: Number(m.media.fileSize ?? 0),
          metadata: (m.media as { metadata?: unknown }).metadata,
        })
      );
      // choosePublishUrl returns either the original url or the media-optimize
      // rendition (H.264 + yuv420p + AAC + +faststart, ≤8Mbps). The video-prep
      // step below publishes a rendition as-is instead of re-encoding it
      // (2026-09-16). Computed HERE, while mediaUrls is still index-aligned
      // with the attachments and untouched by any later step.
      const mediaIsRendition = postTarget.post.mediaAttachments.map((m, i) => mediaUrls[i] !== m.media.url);
      // Size of the file that video prep would actually download and encode:
      // the rendition when one is being sent (its size is recorded by
      // media-optimize), else the original. Checking the ORIGINAL's size here
      // made a >250MB original skip the story 9:16 canvas even though the
      // file being published was a small rendition (adversarial review,
      // 2026-09-16). The encode's own Content-Length cap still guards a
      // rendition that turns out to be large.
      const mediaPrepSizes = postTarget.post.mediaAttachments.map((m, i) => {
        if (!mediaIsRendition[i]) return Number(m.media.fileSize ?? 0);
        const renditionSize = Number(
          ((m.media as { metadata?: unknown }).metadata as { optimize?: { size?: unknown } } | null)?.optimize?.size
        );
        return Number.isFinite(renditionSize) && renditionSize > 0 ? renditionSize : Number(m.media.fileSize ?? 0);
      });
      const mediaTypes = postTarget.post.mediaAttachments.map((m) => m.media.fileType);
      // Number(): fileSize is a Prisma BigInt (Phase 4) — safe up to 2^53,
      // far beyond any real file; keeps the gate math plain-number.
      const mediaSizes = postTarget.post.mediaAttachments.map((m) => Number(m.media.fileSize ?? 0));

      // Heavy-upload slot gate (see HEAVY_MEDIA_CONCURRENCY above). Runs after
      // the atomic claim + publishedId short-circuit (a published target never
      // reaches here) and BEFORE the overlay pass so a deferred job never
      // wastes an ffmpeg re-encode. The SCHEDULED flip releases the claim
      // exactly like the rate-limit path; the atomic claim + publishedId
      // short-circuit keep the delayed re-add idempotent, and job.data carries
      // enqueuedFor so a mid-defer reschedule is still killed by the
      // stale-schedule guard on the next run.
      const totalMediaBytes = mediaSizes.reduce((a, b) => a + b, 0);
      const isHeavy = isHeavyPublish(platform, totalMediaBytes, HEAVY_MEDIA_THRESHOLD_BYTES, HEAVY_STREAM_PLATFORMS);
      const deferPlan = planHeavyDefer({ isHeavy, active: heavyActive, cap: HEAVY_MEDIA_CONCURRENCY });
      if (deferPlan) {
        const { delayMs } = deferPlan; // jittered 45-90s — no lockstep thundering herd
        console.log(
          `[PostPublish] Heavy-upload slots busy (${heavyActive}/${HEAVY_MEDIA_CONCURRENCY}) — deferring ${postTargetId} ${Math.round(delayMs / 1000)}s`
        );
        // Release the claim FIRST, then enqueue — same reasoning as the
        // optimize-wait defer above (2026-09-16).
        await prisma.postTarget.update({
          where: { id: postTargetId },
          // HEAVY_SLOT_WAIT_MESSAGE is ALSO the watchdog's keep-alive marker —
          // a defer-parked target is exempt from the 10-min freshness check
          // (its PRIORITY_RETRY re-queue can legitimately starve behind the
          // fast lane); the 12h hard ceiling stays the terminal backstop.
          data: { status: "SCHEDULED", errorMessage: HEAVY_SLOT_WAIT_MESSAGE },
        });
        await postPublishQueue.add(`retry-heavyslot-${postTargetId}-${Date.now()}`, job.data, {
          delay: delayMs,
          priority: PRIORITY_RETRY,
          attempts: 3,
          backoff: { type: "exponential", delay: 60_000 },
        });
        return;
      }
      // NOTE: the counter increments immediately before the publish try block
      // below (whose finally releases it) — incrementing here would leak the
      // slot if anything between the gate and that try throws.

      // Build merged provider metadata: post intent → target overrides → format → channel IDs (wins)
      const channelMetadata = (channel.metadata ?? {}) as Record<string, unknown>;
      const isStoryTarget = postTarget.format === "STORY";
      // ⚠️ RESHAPING keys on what actually PUBLISHES as a story, not on the
      // format label. instagram.provider.ts sends anything longer than one media
      // to publishCarouselPost, so a legacy per-channel-picker post (Post mode,
      // one Instagram channel set to "Story", two attachments) publishes an
      // ordinary CAROUSEL — padding those slides to 9:16 would silently change
      // what the user published. Facebook stories only come from story MODE,
      // which caps media at one, so this is a no-op there.
      const publishesAsStory = isStoryTarget && postTarget.post.mediaAttachments.length === 1;
      const providerMetadata: Record<string, unknown> = {
        ...((postTarget.post.metadata as object) || {}),
        ...((postTarget.metadata as object) || {}),
        ...(postTarget.format ? { format: postTarget.format } : {}),
        // Stories only: the provider builds the /stories/{username}/{id}/ URL when
        // Meta returns no permalink (`/p/{id}` is a 404 for a story). Gated on the
        // format so every non-story provider payload is byte-identical.
        ...(isStoryTarget && channel.username ? { channelUsername: channel.username } : {}),
        ...channelMetadata, // pageId/igUserId/logo_path MUST win — kept last
      };

      /**
       * Persist a fact the provider learned mid-publish (see
       * SocialPostPayload.onCheckpoint).
       *
       * Instagram stories use it for the media container id: written BEFORE the
       * story is published, so a retry — BullMQ attempt, the 30s cron, or a human
       * clicking Retry — asks Meta what happened to THAT container rather than
       * creating a second one. Without it, a publish that succeeded but whose DB
       * write was lost would produce a duplicate story, which is the 2026-08-18
       * incident reached from a new direction.
       *
       * Written to BOTH the row (survives this job) and the in-memory metadata (so
       * a later attempt inside THIS job sees it).
       *
       * ⚠️ RETHROWS. It is tempting to swallow this as best-effort, but the
       * checkpoint is the ONLY thing standing between a lost DB write and a
       * SECOND live story, and the two writes share this client and this
       * database — so they fail together exactly when it matters. Nothing has
       * been sent to Instagram at this point, so aborting here cannot duplicate;
       * it costs one orphaned container that Meta expires in 24h.
       */
      const onCheckpoint = async (patch: Record<string, unknown>) => {
        Object.assign(providerMetadata, patch);
        try {
          // Re-read so a concurrent writer's keys are preserved — the same merge
          // discipline the channel-metadata writers use.
          const fresh = await prisma.postTarget.findUnique({
            where: { id: postTargetId },
            select: { metadata: true },
          });
          await prisma.postTarget.update({
            where: { id: postTargetId },
            data: { metadata: { ...((fresh?.metadata as object) ?? {}), ...patch } as any },
          });
        } catch (err: any) {
          console.warn(`[PostPublish] checkpoint write failed for target ${postTargetId}: ${err?.message}`);
          throw err;
        }
      };

      // Meta-ready video prep for IG/FB (2026-09-16). Measured on prod: a
      // ~53-channel IG video fan-out waited p50 240s / p90 659s per target in
      // the per-TARGET watermark encode (FIFO semaphore of 2). The owner
      // removed the per-channel watermark, so each video now takes one plan
      // from meta-video-prep.ts: the media-optimize rendition publishes as-is,
      // an original gets ONE shared, cached normalize encode for the whole
      // fan-out, and VIDEO_WATERMARK_ENABLED=true restores the legacy
      // per-target watermark exactly as it was.
      const hasVideo = mediaTypes.some((t) => t?.startsWith("video/"));
      if (hasVideo && ["INSTAGRAM", "FACEBOOK"].includes(platform)) {
        const videoPrepStartedAt = Date.now();
        const videoPrepPlans: string[] = [];
        try {
          const { processVideoOverlay } = await import("../lib/video-overlay");
          const { isVideoWatermarkEnabled, planMetaVideoPrep } = await import("../lib/meta-video-prep");
          const watermarkOn = isVideoWatermarkEnabled();

          // Resolve channel logo from Logo Library — only when the watermark
          // will actually be drawn; otherwise it is a wasted query per target.
          let logoUrl: string | null = null;
          if (watermarkOn) {
            try {
              const logoMedia = await prisma.media.findFirst({
                where: { organizationId: postTarget.post.organizationId, category: "logo", channelId },
                select: { url: true },
              });
              if (logoMedia) logoUrl = logoMedia.url;
            } catch { /* no logo */ }

            // Fallback: check channel metadata for logo_path
            if (!logoUrl) {
              logoUrl = (channelMetadata?.logo_path as string) || null;
            }
          }

          const overlayText = (postTarget.post.metadata as any)?.videoOverlayText as string | undefined;

          const processed: string[] = [];
          let renditionSkipLogged = false;
          for (let i = 0; i < mediaUrls.length; i++) {
            if (!mediaTypes[i]?.startsWith("video/")) {
              processed.push(mediaUrls[i]!);
              continue;
            }
            // Skip the ffmpeg pass on large videos: it downloads the whole file
            // to /tmp, re-encodes it, and re-uploads — untenable for multi-GB
            // Shorts/Reels (disk + CPU + wall-clock). Post the creator's
            // original video as-is instead of failing or stalling.
            const tooBigForOverlay = (mediaPrepSizes[i] ?? 0) > OVERLAY_MAX_BYTES;
            const plan = planMetaVideoPrep({
              watermarkOn,
              hasOverlayText: !!overlayText,
              publishesAsStory,
              isRendition: mediaIsRendition[i] === true,
              tooBig: tooBigForOverlay,
            });
            videoPrepPlans.push(plan);

            if (plan === "skip-too-big") {
              console.log(`[PostPublish] Skipping video prep on large video ${i + 1} (${Math.round((mediaPrepSizes[i] ?? 0) / 1024 / 1024)}MB > ${OVERLAY_MAX_BYTES / 1024 / 1024}MB) — posting it as-is`);
              processed.push(mediaUrls[i]!);
            } else if (plan === "skip-rendition") {
              // Already H.264 + yuv420p + AAC + +faststart — the same shape the
              // normalize encode would produce, and the shape IG/FB already
              // publish directly for >250MB originals.
              if (!renditionSkipLogged) {
                console.log(`[PostPublish] target ${postTargetId}: rendition already Meta-normalized — no re-encode`);
                renditionSkipLogged = true;
              }
              processed.push(mediaUrls[i]!);
            } else if (plan === "watermark") {
              console.log(`[PostPublish] Processing video ${i + 1}: logo=${logoUrl ? "yes" : "name"}, text=${overlayText ? "yes" : "no"}`);
              const newUrl = await processVideoOverlay(mediaUrls[i]!, {
                text: overlayText,
                textPosition: "bottom",
                textFontSize: 42,
                logoUrl,
                channelName: channel.name, // fallback watermark if no logo
                logoPosition: "bottom_right",
                logoSize: 120,
                // Defense-in-depth vs forged/NULL DB fileSize — the overlay
                // re-checks the REAL Content-Length and skips if oversized.
                maxBytes: OVERLAY_MAX_BYTES,
                // A story is 9:16. Padding rides along INSIDE this existing
                // re-encode; a separate pass per target is the 2026-08-07
                // incident. Non-story publishes pass false and are unchanged.
                storyCanvas: publishesAsStory,
              });
              processed.push(newUrl);
            } else {
              // "normalize": NO per-channel input, so processVideoOverlay writes
              // one deterministic, verified artifact that every target of this
              // fan-out (and every retry) reuses.
              console.log(`[PostPublish] target ${postTargetId}: normalizing video ${i + 1} (shared), text=${overlayText ? "yes" : "no"}, story=${publishesAsStory ? "yes" : "no"}`);
              const newUrl = await processVideoOverlay(mediaUrls[i]!, {
                text: overlayText,
                textPosition: "bottom",
                textFontSize: 42,
                // ⚠️ Keep these empty: any per-channel input sends the call down
                // the per-target path and brings back one encode per channel.
                logoUrl: null,
                channelName: undefined,
                // The story canvas rides inside this one encode, as above.
                storyCanvas: publishesAsStory,
                normalize: true,
                maxBytes: OVERLAY_MAX_BYTES,
              });
              processed.push(newUrl);
            }
          }
          // ⚠️ The story canvas rides INSIDE this pass, so wherever the pass is
          // skipped — video over OVERLAY_MAX_BYTES, VIDEO_OVERLAY_ENABLED=false,
          // or the catch below — the video publishes UNPADDED and will be cropped
          // on a phone. processVideoOverlay returns a new URL whenever it ran, so
          // url identity is an exact signal. Say so rather than failing: an
          // unpadded story still publishes.
          if (publishesAsStory) {
            for (let i = 0; i < processed.length; i++) {
              if (mediaTypes[i]?.startsWith("video/") && processed[i] === mediaUrls[i]) {
                console.warn(
                  `[PostPublish] story 9:16 canvas NOT applied to video for target ${postTargetId} (${platform}) — ` +
                    `the overlay pass was skipped (size cap or VIDEO_OVERLAY_ENABLED=false); publishing the original`
                );
              }
            }
          }
          mediaUrls = processed;
        } catch (e) {
          console.warn(`[PostPublish] Video overlay failed, posting without:`, (e as Error).message);
          // The canvas warning above lives inside the try, so a THROWN prep
          // (short download, truncated encode, S3 error) never reached it —
          // yet the story still publishes unpadded. Keep the promise that every
          // unpadded story logs this line.
          if (publishesAsStory) {
            console.warn(
              `[PostPublish] story 9:16 canvas NOT applied to video for target ${postTargetId} (${platform}) — ` +
                `video prep failed (${(e as Error).message}); publishing the original`
            );
          }
        }
        console.log(
          `[PostPublish] target ${postTargetId} (${platform}) video prep ${Date.now() - videoPrepStartedAt}ms plan=${videoPrepPlans.join(",") || "none"}`
        );
      } else if (publishesAsStory && hasVideo) {
        console.warn(
          `[PostPublish] story 9:16 canvas NOT applied to video for target ${postTargetId} (${platform}) — ` +
            `the overlay pass does not run for this platform; publishing the original`
        );
      }

      // ── Story IMAGES must be exactly 9:16 (2026-09-16) ─────────────────────
      // Meta does not normalise an organic story: the phone app fills (cropping
      // the caption off a 4:5 creative — the owner's report) while the web
      // viewer fits. An exactly-9:16 asset is a fixed point for both, so we
      // compose one, the way the Instagram app does when posting by hand.
      //
      // Video is handled INSIDE the overlay pass above (one encode). Images are
      // cheap, so they are fitted here. ensureStoryImageUrl is FAIL-OPEN — every
      // error returns the original URL — and writes to a deterministic S3 key,
      // so one render serves the whole fan-out and every retry.
      if (publishesAsStory && ["INSTAGRAM", "FACEBOOK"].includes(platform)) {
        try {
          const { ensureStoryImageUrl } = await import("../lib/story-media");
          const fitted: string[] = [];
          for (let i = 0; i < mediaUrls.length; i++) {
            const mediaId = postTarget.post.mediaAttachments[i]?.media.id;
            if (mediaTypes[i]?.startsWith("video/") || !mediaId) {
              fitted.push(mediaUrls[i]!);
              continue;
            }
            fitted.push(
              await ensureStoryImageUrl({
                url: mediaUrls[i]!,
                organizationId: postTarget.post.organizationId,
                mediaId,
                platform,
              })
            );
          }
          mediaUrls = fitted;
        } catch (e) {
          console.warn(`[PostPublish] Story image fit failed, posting original:`, (e as Error).message);
        }
      }

      // Auto-generate AI image for media-required platforms (Instagram, Facebook) if no media attached.
      //
      // ⚠️ NEVER for a STORY. A story is the user's own photo or clip — silently
      // publishing a generated image to their story would be the product inventing
      // content nobody asked for. Without media the provider fails with its own
      // clear "requires at least one image or video" message instead.
      const mediaRequiredPlatforms = ["INSTAGRAM", "FACEBOOK"];
      if (mediaUrls.length === 0 && mediaRequiredPlatforms.includes(platform) && !isStoryTarget) {
        console.log(`[PostPublish] No media for ${platform} — auto-generating AI image...`);
        try {
          const { generateImage } = await import("@postautomation/ai");
          const headline = content.split("\n")[0]?.slice(0, 100) || "Social Media Post";
          const aiResult = await generateImage({
            prompt: `Create a professional, eye-catching social media post image about: "${headline}".
Visually stunning design with bold modern typography, vibrant colors, dramatic imagery related to the topic.
4:5 portrait aspect ratio. Premium quality social media creative. Do NOT include watermarks.`,
            aspectRatio: "3:4",
          });

          // Upload to S3
          const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
          const s3 = new S3Client({
            region: process.env.S3_REGION || "us-east-1",
            endpoint: process.env.S3_ENDPOINT || undefined,
            forcePathStyle: true,
            credentials: {
              accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || "",
              secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || "",
            },
          });
          const bucket = process.env.S3_BUCKET || "postautomation-media";
          const ext = aiResult.mimeType.includes("png") ? "png" : "jpg";
          const ct = aiResult.mimeType.includes("png") ? "image/png" : "image/jpeg";
          const key = `auto-gen/${platform.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
          const buf = Buffer.from(aiResult.imageBase64, "base64");
          await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buf, ContentType: ct }));
          const publicUrl = process.env.S3_PUBLIC_URL
            ? `${process.env.S3_PUBLIC_URL}/${key}`
            : `${process.env.S3_ENDPOINT || "https://s3.amazonaws.com"}/${bucket}/${key}`;
          mediaUrls = [publicUrl];
          mediaTypes.push(ct);
          console.log(`[PostPublish] AI image generated and uploaded: ${publicUrl}`);
        } catch (aiErr) {
          console.warn(`[PostPublish] AI image generation failed:`, (aiErr as Error).message);
          // Will fail at validation below
        }
      }

      // Auto-truncate content to platform limit
      const publishContent = truncateForPlatform(content, platform);
      if (publishContent.length !== content.length) {
        console.log(`[PostPublish] Auto-truncated content from ${content.length} to ${publishContent.length} chars for ${platform}`);
      }

      // Validate content before publishing
      const errors = provider.validateContent({ content: publishContent, mediaUrls, mediaTypes });
      if (errors.length > 0) {
        // A media-required platform with no media is the common "stuck scheduled
        // post" cause. Terminalize it now with a clear human reason instead of
        // throwing a generic Validation-failed error into the retry loop (which
        // would orphan it at PUBLISHING). UnrecoverableError stops BullMQ retries.
        if (
          mediaUrls.length === 0 &&
          mediaRequiredPlatforms.includes(platform)
        ) {
          const reason = mediaRequiredReason(platform, { isStory: isStoryTarget });
          await markTargetFailed(prisma, postTargetId, reason);
          throw new UnrecoverableError(reason);
        }
        // Validation is deterministic for this input (e.g. 11 images where
        // Instagram allows 10) — a retry fails identically. Terminal with the
        // real reason. The old plain throw orphaned all 60 targets of such a
        // post at PUBLISHING for 30-56 min (2026-09-16).
        const validationReason = `Validation failed: ${errors.join(", ")}`;
        await markTargetFailed(prisma, postTargetId, validationReason);
        throw new UnrecoverableError(validationReason);
      }

      // Re-impose the same-platform spacing between this post's publish calls
      // (a no-op when the enqueue stagger already spaced them). Still before
      // dispatch: nothing has been sent, so the pre-publish claim guard covers
      // any throw here.
      if (PACED_DISPATCH_PLATFORMS.has(platform)) {
        const pacedMs = await dispatchPacer.waitTurn(`${postTarget.postId}:${platform}`, resolvePlatformStaggerMs(platform));
        if (pacedMs > 0) {
          console.log(`[PostPublish] target ${postTargetId} (${platform}) paced ${pacedMs}ms to keep same-post spacing`);
        }
      }

      let result;
      if (isHeavy) heavyActive++;
      try {
        // ⚠️ From HERE the platform may end up holding this post (pre-flight
        // adoption, publishPost), so the Worker wrapper must no longer release
        // the claim — the catch branches below own every terminal write.
        state.dispatched = true;
        console.log(`[PostPublish] Publishing to ${platform} via ${provider.displayName} (mediaUrls: ${mediaUrls.length})`);

        // Build progress callback — only meaningful for media-heavy platforms (YouTube etc.)
        const onProgress = (percent: number) => reportProgress(postTargetId, percent);

        // ── PRE-FLIGHT RECONCILIATION ──────────────────────────────────────────
        // On a RETRY, ask the platform whether the previous attempt actually
        // landed before writing again. This covers the one gap the publishedId
        // short-circuit cannot: an attempt that published successfully but whose
        // DB write never persisted leaves publishedId NULL, so the short-circuit
        // misses and the retry duplicates the post.
        //
        // Costs one listing call, only on retries, only for providers that
        // implement findExistingPost (Instagram + Facebook today). Every other
        // provider takes the identical path it always did.
        if (
          shouldPreflightReconcile({
            attemptsMade: job.attemptsMade,
            // Durable across jobs — worker.on("failed") increments it. Required
            // because every human Retry and every internal re-queue arrives as a
            // BRAND-NEW job with attemptsMade === 0.
            targetAttemptedBefore: (postTarget.retryCount ?? 0) > 0 || postTarget.errorMessage != null,
            hasPublishedId: !!postTarget.publishedId,
            providerSupportsReconcile: typeof provider.findExistingPost === "function",
          })
        ) {
          const lookbackFloor = new Date(Date.now() - PREFLIGHT_LOOKBACK_MS);
          const postCreatedAt = postTarget.post.createdAt ?? lookbackFloor;
          const since = postCreatedAt > lookbackFloor ? postCreatedAt : lookbackFloor;
          try {
            const existing = await provider.findExistingPost!(
              tokens,
              { content: publishContent, mediaUrls, mediaTypes, metadata: providerMetadata },
              since,
            );
            if (existing) {
              // ⚠️ Guard against adopting a DIFFERENT post that merely shares this
              // caption — this account posts near-identical copy routinely. If the
              // platform id is already recorded against another target, the match
              // is not ours and we must publish normally.
              const claimedElsewhere = await prisma.postTarget.findFirst({
                where: { publishedId: existing.platformPostId, id: { not: postTargetId } },
                select: { id: true },
              });
              if (claimedElsewhere) {
                console.warn(`[PostPublish] pre-flight match ${existing.platformPostId} already belongs to target ${claimedElsewhere.id} — publishing normally`);
              } else {
                console.warn(`[PostPublish] pre-flight found ${platform} post ${existing.platformPostId} already live for target ${postTargetId} — adopting instead of re-publishing`);
                result = existing;
              }
            }
          } catch (reconcileErr: any) {
            // Could not tell. Do NOT publish — that is the duplicate. Park it.
            const reason = `A previous attempt to publish this may already have gone live, and ${platform} could not confirm either way. Nothing was re-sent. Check the account, then use "It didn't publish" to try again. (${reconcileErr?.message ?? "unknown error"})`;
            await markTargetAmbiguous(prisma, postTargetId, reason);
            throw new UnrecoverableError(reason);
          }
        }

        // Retry up to 3 times for transient network errors (fetch timeouts under heavy load)
        let lastErr: any;
        for (let attempt = 1; attempt <= 3 && !result; attempt++) {
          try {
            result = await provider.publishPost(tokens, { content: publishContent, mediaUrls, mediaTypes, metadata: providerMetadata, onProgress, onCheckpoint });
            lastErr = null;
            break;
          } catch (e: any) {
            lastErr = e;
            // ⚠️ NEVER replay a publish whose outcome is unknown. This loop used to
            // re-call publishPost on any "fetch failed"/ETIMEDOUT — but a timeout
            // AFTER the request was dispatched is exactly the case where the
            // platform may already hold the post, and re-calling publishPost
            // restarts the create from scratch (a new IG container = a new post).
            if (isAmbiguousPublishError(e)) throw e;
            if (attempt < 3 && (e.message === "fetch failed" || e.message?.includes("ETIMEDOUT"))) {
              console.log(`[PostPublish] Transient error on attempt ${attempt}/3, retrying in ${attempt * 3}s...`);
              await new Promise((r) => setTimeout(r, attempt * 3000));
              continue;
            }
            throw e;
          }
        }
        if (lastErr) throw lastErr;
      } catch (publishErr: any) {
        // ⚠️ ROUTE BEFORE CLASSIFYING — the order here is load-bearing.
        // classifyError substring-matches, so "token"+"invalid" anywhere in a
        // message yields token_expired, and THAT branch refreshes the credential
        // and calls provider.publishPost AGAIN. The commonest reason we cannot
        // confirm an outcome is a dead Meta token, whose reconciliation error
        // reads "...(token_invalid) — cannot confirm whether the post published".
        // Classifying first would therefore route an UNKNOWN outcome straight
        // into a re-publish — the exact duplicate this fix prevents.
        const route = routePublishError(publishErr);
        if (route === "ambiguous") {
          // THE 2026-08-13 FIX. Park the target: FAILED (so the watchdog, UI and
          // publish report behave exactly as before) PLUS ambiguousAt, which
          // removes it from the atomic claim so no retry layer can re-publish it.
          const reason = publishErr.message || String(publishErr);
          await markTargetAmbiguous(prisma, postTargetId, reason);
          console.warn(`[PostPublish] target ${postTargetId} parked as AMBIGUOUS — ${platform} never confirmed the publish; not retrying (job ${job.id})`);
          throw new UnrecoverableError(reason);
        }
        if (route === "terminal") {
          // Already decided elsewhere (e.g. the pre-flight parked it). Rethrow
          // untouched so BullMQ stops and nothing re-classifies it.
          throw publishErr;
        }

        const errMsg = publishErr.message || String(publishErr);
        const errType = classifyError(errMsg);
        console.error(`[PostPublish] Publish error detail:`, errMsg);
        if (publishErr.cause) {
          const cause = publishErr.cause;
          if (cause.errors) {
            cause.errors.forEach((e: any, i: number) => console.error(`[PostPublish] Cause[${i}]:`, e.message, e.code, e.address, e.port));
          } else {
            console.error(`[PostPublish] Cause:`, String(cause));
          }
        }
        console.log(`[PostPublish] Error classified as: ${errType}`);

        if (errType === "rate_limit") {
          // Facebook error 368 (spam throttle) can last hours — use a much longer
          // backoff for FB. Other platforms use 2min→5min→10min.
          let delayMs: number;
          if (platform === "FACEBOOK") {
            // 30min → 2h → 6h — FB spam blocks don't clear in seconds
            const fbBackoffs = [30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];
            delayMs = fbBackoffs[Math.min(job.attemptsMade, fbBackoffs.length - 1)] ?? 6 * 60 * 60_000;
          } else {
            // 2min → 5min → 10min for other platforms
            delayMs = Math.min(120_000 * Math.pow(2, job.attemptsMade), 600_000);
          }
          console.log(`[PostPublish] Rate-limited (${platform}) — re-queuing with ${Math.round(delayMs / 60_000)}min delay`);
          await postPublishQueue.add(
            `retry-ratelimit-${postTargetId}-${Date.now()}`,
            job.data,
            // PRIORITY_RETRY: when the delay expires this re-queue yields to
            // fresh interactive + bulk work (@postautomation/queue publish-priority).
            { delay: delayMs, priority: PRIORITY_RETRY, attempts: 3, backoff: { type: "exponential", delay: 60_000 } }
          );
          // Mark as SCHEDULED (not FAILED) so the UI shows it's pending
          await prisma.postTarget.update({
            where: { id: postTargetId },
            data: { status: "SCHEDULED", errorMessage: `Rate-limited, retrying in ${Math.round(delayMs / 60_000)}min` },
          });
          return; // Don't throw — this is handled
        }

        if (errType === "token_expired") {
          // Force token refresh and retry once
          console.log(`[PostPublish] Token expired — forcing refresh for channel ${channelId}`);
          // Which step failed decides whether a retry could ever help (see the
          // catch below, 2026-09-16).
          let refreshAttempted = false;
          let refreshSucceeded = false;
          try {
            // Same rule as the pre-publish refresh above: a Meta token is
            // refreshable only by the app that minted it.
            const creds = resolvePlatformCredentials(platform, channel.metaAppId);
            const clientId = creds?.clientId || "";
            const clientSecret = creds?.clientSecret || "";
            if (clientId && clientSecret && channel.refreshToken) {
              refreshAttempted = true;
              const refreshed = await provider.refreshAccessToken(
                channel.refreshToken,
                { clientId, clientSecret, callbackUrl: `${process.env.APP_URL || ""}/api/oauth/callback/${platform.toLowerCase()}`, scopes: [] }
              );
              refreshSucceeded = true;
              await prisma.channel.update({
                where: { id: channelId },
                data: {
                  accessToken: refreshed.accessToken,
                  refreshToken: refreshed.refreshToken ?? channel.refreshToken,
                  tokenExpiresAt: refreshed.expiresAt ? new Date(refreshed.expiresAt) : undefined,
                },
              });
              // Retry immediately with fresh token
              result = await provider.publishPost(
                { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken ?? channel.refreshToken ?? undefined },
                // ⚠️ onCheckpoint here too: this is a SECOND publishPost call, and
                // for a story the first one may already have created a container.
                // providerMetadata was mutated in place by the first checkpoint, so
                // this call resumes from it rather than creating a duplicate.
                { content: publishContent, mediaUrls, mediaTypes, metadata: providerMetadata, onProgress: (percent: number) => reportProgress(postTargetId, percent), onCheckpoint }
              );
              console.log(`[PostPublish] Retry with fresh token succeeded`);
            } else {
              throw publishErr; // Can't refresh — rethrow original error
            }
          } catch (refreshRetryErr: any) {
            // ⚠️ This branch RE-PUBLISHES with the refreshed token, so it can raise
            // an ambiguity of its own. Writing plain FAILED here would drop the
            // target back into the claim set and invite another re-publish.
            if (isAmbiguousPublishError(refreshRetryErr)) {
              const reason = refreshRetryErr.message || String(refreshRetryErr);
              await markTargetAmbiguous(prisma, postTargetId, reason);
              console.warn(`[PostPublish] target ${postTargetId} parked as AMBIGUOUS after token-refresh re-publish (job ${job.id})`);
              throw new UnrecoverableError(reason);
            }
            // Mark FAILED before throwing — otherwise the target stays at PUBLISHING,
            // the BullMQ retry's claim guard skips it as a "duplicate" (claim.count === 0),
            // and it's orphaned at PUBLISHING forever. Mirrors the generic else branch below.
            const tokenErrMsg = `Token expired and refresh failed: ${refreshRetryErr.message}. Reconnect this channel in Settings.`;
            await markTargetFailed(prisma, postTargetId, tokenErrMsg);
            // ── Dead credential ⇒ stop retrying (2026-09-16) ─────────────────
            // When the REFRESH itself failed (or none was possible) with a
            // definite auth error, the next attempt would fail identically — and
            // worse, its duplicate pre-flight cannot list the account with that
            // dead token, so it parked the target as "may already have gone
            // live" (73 false ambiguities since 2026-09-14). Nothing was
            // published, so terminal FAILED with the reconnect message is the
            // truth. If the refresh SUCCEEDED and the re-publish failed, or the
            // evidence is not definite, behaviour is unchanged (plain Error).
            const authEvidence = refreshAttempted ? refreshRetryErr?.message : errMsg;
            if (!refreshSucceeded && isDefiniteAuthFailure(authEvidence)) {
              console.warn(`[PostPublish] target ${postTargetId}: ${platform} credential is dead — failing without retry (reconnect required)`);
              throw new UnrecoverableError(tokenErrMsg);
            }
            throw new Error(tokenErrMsg);
          }
        } else if (errType === "media_required") {
          // Media-required platform (IG/FB) with no usable media. Retrying re-runs
          // the same media-less input and fails identically; the retry's claim
          // guard would then skip it as a duplicate and orphan it at PUBLISHING.
          // Mark FAILED here with a clear human reason so the user knows to attach
          // media or enable AI image generation.
          const reason = mediaRequiredReason(platform, { isStory: isStoryTarget });
          await markTargetFailed(prisma, postTargetId, reason);
          throw new UnrecoverableError(reason);
        } else if (errType === "content_too_large") {
          // Aggressively truncate and retry
          const aggressiveContent = truncateForPlatform(publishContent, platform);
          console.log(`[PostPublish] Content too large — retrying with aggressive truncation`);
          try {
            result = await provider.publishPost(tokens, { content: aggressiveContent.slice(0, Math.floor(aggressiveContent.length * 0.7)), mediaUrls, mediaTypes, metadata: providerMetadata, onCheckpoint });
          } catch (truncateRetryErr: any) {
            // Same hazard as the token-refresh branch above: this is a SECOND
            // publish call, so it can produce its own ambiguity.
            if (isAmbiguousPublishError(truncateRetryErr)) {
              const reason = truncateRetryErr.message || String(truncateRetryErr);
              await markTargetAmbiguous(prisma, postTargetId, reason);
              console.warn(`[PostPublish] target ${postTargetId} parked as AMBIGUOUS after truncated re-publish (job ${job.id})`);
              throw new UnrecoverableError(reason);
            }
            // The truncated retry also failed — mark FAILED before propagating so the
            // target doesn't orphan at PUBLISHING (same reasoning as the else branch).
            await markTargetFailed(prisma, postTargetId, truncateRetryErr?.message ?? errMsg);
            throw truncateRetryErr;
          }
        } else {
          // Unknown / unrecoverable error (e.g. a landscape video rejected by the
          // Shorts validator). Retrying re-runs the SAME input and fails identically,
          // but the retry's claim guard sees the target still PUBLISHING and skips it
          // as a "duplicate" — so the worker.on("failed") final-attempt FAILED write
          // never fires and the target is orphaned at PUBLISHING forever (UI shows
          // "perpetually publishing"). Mark FAILED here, before throwing, so the DB
          // reaches a terminal state, the UI stops polling, and the user sees the
          // actionable error with a Retry button.
          await prisma.postTarget.update({
            where: { id: postTargetId },
            data: { status: "FAILED", errorMessage: errMsg },
          }).catch((e: any) => console.error(`[PostPublish] failed to mark target FAILED:`, e?.message));
          throw publishErr; // rethrow so BullMQ records the job failure + error log
        }
      } finally {
        // Release the heavy-upload slot on EVERY exit from the publish section
        // — success, rate-limit defer return, token-refresh/truncation retry
        // paths, and throws all pass through here.
        if (isHeavy) heavyActive = Math.max(0, heavyActive - 1);
      }

      if (!result) {
        throw new Error("Publish returned no result");
      }

      // 4. Mark as PUBLISHED — isolated try/catch so a DB hiccup here doesn't cause
      // BullMQ to retry and re-call provider.publishPost() for an already-published post.
      let updatedTarget: Awaited<ReturnType<typeof prisma.postTarget.update>>;
      try {
        updatedTarget = await prisma.postTarget.update({
          where: { id: postTargetId },
          data: {
            status: "PUBLISHED",
            publishedId: result.platformPostId,
            publishedUrl: result.url,
            publishedAt: new Date(),
            uploadProgress: null,
            // A target that failed and then succeeded used to keep its stale
            // errorMessage forever — which is how `papcontent` and `filmiimemes`
            // ended up PUBLISHED while still displaying "Instagram publish
            // failed". Clear it, and clear any ambiguity stamp: the outcome is
            // now known.
            errorMessage: null,
            ambiguousAt: null,
            ambiguousReason: null,
            metadata: (result.metadata ?? undefined) as any,
          },
        });
      } catch (dbErr: any) {
        console.error(`[PostPublish] DB write PUBLISHED failed for ${postTargetId}: ${dbErr.message} — post was published on platform but status not persisted`);
        // Do not rethrow — BullMQ must not retry (would re-publish)
        return result;
      }

      // 4a. In-app notification for org owners/admins (best-effort, never fails publish)
      await notifyPublishOutcome(postTarget.post.organizationId, postTarget.postId, postTargetId, platform, "PUBLISHED");

      // 4b. Fetch & save initial analytics snapshot (best-effort)
      if (result.platformPostId) {
        try {
          const analytics = await provider.getPostAnalytics(tokens, result.platformPostId);
          if (analytics) {
            await prisma.analyticsSnapshot.create({
              data: {
                postTargetId: updatedTarget.id,
                platform: platform as any,
                impressions: analytics.impressions ?? 0,
                clicks: analytics.clicks ?? 0,
                likes: analytics.likes ?? 0,
                shares: analytics.shares ?? 0,
                comments: analytics.comments ?? 0,
                reach: analytics.reach ?? 0,
                // ⚠️ `?? null`, never `?? 0` — NULL is "never captured" ("—"),
                // 0 asserts a measured zero. This create was missed when views
                // shipped, so a freshly published post stored metricsAvailable
                // .views:true beside a NULL column until the next sync.
                views: analytics.views ?? null,
                engagementRate: analytics.engagementRate ?? 0,
                // Only the honesty metadata (likeKind/reachIsDistinct/saved/
                // metricsAvailable/source) — NOT the whole analytics object
                // (whose numeric fields are already columns).
                ...(() => {
                  const md = buildSnapshotMetadata(analytics as any, undefined, false);
                  return md ? { metadata: md as any } : {};
                })(),
              },
            });
            console.log(`[Analytics] Snapshot saved for ${postTargetId}`);
          }
        } catch (analyticsErr: any) {
          console.warn(`[Analytics] Snapshot failed for ${postTargetId}:`, analyticsErr.message);
        }
      }

      // 4c. Enqueue at-age metric checkpoints (Insights → Reports "at publish-age"
      // mode): four DELAYED analytics-sync jobs snapshot this target's metrics as
      // they stand exactly 24h/7d/15d/30d after publish (metadata.windowTag).
      // Exact-at-window vs the ±6h cron; also covers FACEBOOK (excluded from the
      // 6-hourly cron for quota reasons — 4 one-shot calls per post are negligible).
      // jobId dedupes BullMQ retries of this publish job. Best-effort: a Redis
      // hiccup must never fail an already-published post.
      // A STORY gets ONE checkpoint, an hour before Instagram withdraws it (the
      // job's delay is measured from enqueue, so a flat 24h always lands after
      // expiry). Every other format keeps all four, with identical delays.
      // ⚠️ NOT for a FACEBOOK story. Meta removed the old per-story metrics in
      // v25.0, and the Stories Insights reference 404s, so the replacement metric
      // names, node and permission are all unpublished. A speculative capture is
      // a guaranteed-failing Graph call — and one invalid metric name 400s the
      // WHOLE insights request. A Facebook story therefore keeps only its
      // publish-time snapshot until story insights are built deliberately.
      const skipAtAgeCheckpoints = isStoryTarget && platform === "FACEBOOK";
      if (result.platformPostId && !skipAtAgeCheckpoints) {
        for (const [windowTag, delay] of atAgeWindowsForFormat(postTarget.format)) {
          try {
            await analyticsSyncQueue.add(
              "at-age-snapshot",
              {
                postTargetId: updatedTarget.id,
                channelId: updatedTarget.channelId,
                platform,
                platformPostId: result.platformPostId,
                windowTag,
              },
              { delay, jobId: `atage:${updatedTarget.id}:${windowTag}`, removeOnComplete: true, removeOnFail: true }
            );
          } catch (queueErr: any) {
            console.warn(`[Analytics] at-age checkpoint enqueue failed (${windowTag}) for ${postTargetId}:`, queueErr.message);
          }
        }
      }

      // 4d. FACEBOOK VIDEO/REEL: one early, untagged analytics pass.
      //
      // Step 4b above asked the Video node (the id is not resolved yet), which reports
      // NOTHING for a reel. FACEBOOK is excluded from BOTH recurring passes and
      // scheduleFacebookAnalyticsSync only considers targets already stale by 48h, so
      // the next thing to touch this target would be the 24h at-age checkpoint — a
      // full day of views showing "—" right after publishing.
      //
      // This enqueues ONE untagged job ~45 min out. analytics-sync resolves the bare
      // Video id to a post id, persists it, and reads the POST node, so views/reach/
      // impressions appear within the hour and every later sync is free.
      //
      // ⚠️ An ENQUEUE, not a Graph call — getFeedPostAnalytics's "network shape is
      // FROZEN" contract is untouched. Untagged on purpose: a windowTag would forge an
      // at-age checkpoint that Reports would then pin.
      if (result.platformPostId) {
        const videoPlan = planFacebookAnalyticsId({ platform, publishedId: result.platformPostId });
        if (videoPlan.needsResolve) {
          try {
            await analyticsSyncQueue.add(
              "early-video-snapshot",
              {
                postTargetId: updatedTarget.id,
                channelId: updatedTarget.channelId,
                platform,
                platformPostId: result.platformPostId,
              },
              {
                delay: earlyVideoSyncDelayMs(process.env.FB_EARLY_VIDEO_SYNC_DELAY_MS),
                // BullMQ requires EXACTLY three colon-separated segments.
                jobId: `vidsync:${updatedTarget.id}:v1`,
                removeOnComplete: true,
                removeOnFail: true,
              }
            );
          } catch (queueErr: any) {
            console.warn(`[Analytics] early video sync enqueue failed for ${postTargetId}:`, queueErr.message);
          }
        }
      }

      // 5. Check if all targets are published and update parent post (best-effort)
      try {
        const allTargets = await prisma.postTarget.findMany({
          where: { postId: postTarget.postId },
          include: { channel: { select: { platform: true, name: true, username: true } } },
        });
        const allPublished = allTargets.every((t) => t.status === "PUBLISHED");
        const allTerminal = allTargets.every((t) => t.status === "PUBLISHED" || t.status === "FAILED");
        if (allPublished) {
          await prisma.post.update({
            where: { id: postTarget.postId },
            data: { status: "PUBLISHED", publishedAt: new Date() },
          });

          // Send email report with all published links
          await sendPublishReportEmail(postTarget.post.organizationId, postTarget.postId, postTarget.post.content, allTargets);
        } else if (allTerminal) {
          // Mixed outcome where the LAST terminal event is a SUCCESS (a
          // sibling already failed terminally): mirror the failed-handler's
          // finalize — without this the post sits at PUBLISHING (spinning
          // header) until an unrelated later event rescues it (live-seen
          // 2026-07-21: IG published after Twitter had failed).
          await prisma.post.update({
            where: { id: postTarget.postId },
            data: { status: "PUBLISHED", publishedAt: new Date() },
          });
          await sendPublishReportEmail(postTarget.post.organizationId, postTarget.postId, postTarget.post.content, allTargets);
        }
      } catch (aggregateErr: any) {
        console.warn(`[PostPublish] Post aggregation step failed for ${postTargetId}: ${aggregateErr.message}`);
      }

      console.log(
        formatPublishTiming({
          postTargetId,
          platform,
          timestamp: job.timestamp,
          processedOn: job.processedOn,
          delay: job.opts?.delay,
          now: Date.now(),
        })
      );
      console.log(`[PostPublish] Successfully published ${postTargetId} to ${platform}`);
      return result;
  };

  const worker = new Worker<PostPublishJobData>(
    QUEUE_NAMES.POST_PUBLISH,
    // ── Pre-publish claim guard (2026-09-16) ────────────────────────────────
    // Anything that throws AFTER this job won the atomic claim but BEFORE the
    // publish `try` (validation, a DB blip, a provider lookup, a failed defer
    // write) used to leave the target at PUBLISHING with nothing to finish it:
    // an 11-image post orphaned all 60 targets for 30-56 min, and the BullMQ
    // retry lost the claim and completed silently as a "duplicate".
    //
    // Nothing reached the platform before `dispatched`, so releasing to FAILED
    // (re-claimable) is safe and lets BullMQ's normal retry — plus the
    // duplicate pre-flight — take over. ⚠️ From `dispatched` on, the platform
    // may hold the post, and ONLY the publish catch branches may write a
    // terminal state; releasing there could re-publish a live post.
    async (job: Job<PostPublishJobData>) => {
      const state: PublishJobState = { claimed: false, dispatched: false };
      try {
        return await processPublishJob(job, state);
      } catch (err) {
        if (state.claimed && !state.dispatched) {
          await releaseClaimAfterPrePublishError(prisma, job.data.postTargetId, err);
        }
        throw err;
      } finally {
        if (state.claimed) releaseLocalClaim(job.data.postTargetId);
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: PUBLISH_CONCURRENCY,
      // Global safety valve only — per-platform pacing is the stagger + reactive
      // backoff (see PUBLISH_CONCURRENCY comment above). Env-tunable.
      limiter: { max: PUBLISH_LIMITER_MAX, duration: 5000 },
      stalledInterval: 30_000,  // check for stalled jobs every 30s
      maxStalledCount: 2,       // move to failed after 2 stall cycles (not infinite retry)
    }
  );

  // Tracked (2026-09-16): BullMQ never awaits this async listener, so the
  // graceful drain waits for it explicitly (lib/background-tasks.ts) —
  // otherwise a job that fails DURING shutdown loses its terminal write,
  // notification and publish email when the process exits.
  const handleFailedJob = async (job: Job<PostPublishJobData> | undefined, err: Error) => {
    if (!job) return;
    try {
      // ⚠️ Route before classifying, for the same reason as the publish catch: an
      // ambiguity message mentioning an invalid token would otherwise be rewritten
      // as "Access token expired. Please reconnect this channel" — clobbering the
      // actionable "may already be live, go and check" text with something
      // misleading, and hiding the one state the operator must act on.
      const route = routePublishError(err);
      const errType = route === "classify" ? classifyError(err.message) : "unknown";
      console.error(`[PostPublish] Job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts?.attempts ?? 1}, route: ${route}, type: ${errType}):`, err.message);

      // ⚠️ An UnrecoverableError IS final even on attempt 1. BullMQ still
      // increments attemptsMade, so the arithmetic alone reports "not final" and
      // everything gated on it — the FAILED write, the notification, and the
      // parent-post finalization + publish email — silently never runs. That left
      // an ambiguous (or media-required) target with no notification and the post
      // hanging in PUBLISHING until the 45-minute watchdog reaped it.
      const isFinalAttempt =
        job.attemptsMade >= (job.opts?.attempts ?? 1) || route !== "classify";

      // Build user-friendly error message
      let userMessage = err.message;
      if (errType === "rate_limit") userMessage = "Platform rate limit hit. Will retry automatically.";
      else if (errType === "token_expired") userMessage = "Access token expired. Please reconnect this channel in Settings.";
      else if (errType === "permission") userMessage = "Missing permissions. Check app permissions in platform developer console.";
      else if (errType === "content_too_large") userMessage = "Content exceeds platform character limit.";
      else if (errType === "media_required") userMessage = "This platform requires at least one image or video.";

      // Update PostTarget — guard against P2025 (target may have been deleted)
      try {
        await prisma.postTarget.update({
          where: { id: job.data.postTargetId },
          data: {
            ...(isFinalAttempt ? { status: "FAILED" } : {}),
            errorMessage: userMessage,
            retryCount: { increment: 1 },
          },
        });
      } catch (dbErr: any) {
        if (dbErr?.code === "P2025") {
          console.warn(`[PostPublish] PostTarget ${job.data.postTargetId} no longer exists — skipping error write`);
        } else {
          console.error(`[PostPublish] Failed to update PostTarget:`, dbErr?.message);
        }
      }

      // Log to ErrorLog for monitoring dashboard.
      // Skip demo SEED posts (seed-post-NNN on fake-token channels) — their
      // guaranteed 401s are not bugs and only pollute the Monitoring page.
      if (isFinalAttempt && !isSeedNoise(job.data)) {
        try {
          const fp = require("crypto").createHash("md5").update(`${err.message}::${job.data.platform}`).digest("hex");
          const existing = await prisma.errorLog.findFirst({
            where: { fingerprint: fp, resolved: false, lastSeenAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
          });
          if (existing) {
            await prisma.errorLog.update({
              where: { id: existing.id },
              data: { occurrences: { increment: 1 }, lastSeenAt: new Date() },
            });
          } else {
            await prisma.errorLog.create({
              data: {
                source: "publish",
                severity: errType === "rate_limit" ? "warning" : "error",
                message: userMessage,
                stack: err.stack?.slice(0, 5000),
                endpoint: `PostPublish/${job.data.platform}`,
                organizationId: job.data.organizationId,
                fingerprint: fp,
                metadata: {
                  platform: job.data.platform,
                  postId: job.data.postId,
                  postTargetId: job.data.postTargetId,
                  channelId: job.data.channelId,
                  errorType: errType,
                  attempts: job.attemptsMade,
                },
              },
            });
          }
        } catch (logErr: any) {
          console.warn(`[PostPublish] ErrorLog write failed:`, logErr?.message);
        }
      }

      // If this was the final attempt, check if ALL targets have failed/completed
      // and update parent post status accordingly
      if (isFinalAttempt) {
        try {
          const postTarget = await prisma.postTarget.findUnique({
            where: { id: job.data.postTargetId },
            include: { post: { select: { content: true, organizationId: true } } },
          });
          if (postTarget) {
            // In-app FAILED notification for org owners/admins (best-effort, never throws)
            await notifyPublishOutcome(
              postTarget.post.organizationId,
              postTarget.postId,
              job.data.postTargetId,
              job.data.platform,
              "FAILED"
            );

            const allTargets = await prisma.postTarget.findMany({
              where: { postId: postTarget.postId },
              include: { channel: { select: { platform: true, name: true, username: true } } },
            });
            const allDone = allTargets.every((t) => t.status === "PUBLISHED" || t.status === "FAILED");
            const allFailed = allTargets.every((t) => t.status === "FAILED");
            if (allDone) {
              await prisma.post.update({
                where: { id: postTarget.postId },
                data: { status: allFailed ? "FAILED" : "PUBLISHED" },
              });

              // Send email report with publish results (including failures)
              await sendPublishReportEmail(postTarget.post.organizationId, postTarget.postId, postTarget.post.content, allTargets);
            }
          }
        } catch (finalErr: any) {
          console.warn(`[PostPublish] Failed to update parent post status:`, finalErr?.message);
        }
      }
    } catch (handlerErr: any) {
      // Never let the failed handler itself crash the worker
      console.error(`[PostPublish] Unhandled error in failed handler for job ${job.id}:`, handlerErr?.message);
    }
  };
  worker.on("failed", (job, err) => {
    trackBackgroundTask(handleFailedJob(job, err));
  });

  worker.on("completed", (job) => {
    console.log(`[PostPublish] Job ${job.id} completed`);
  });

  return worker;
}
