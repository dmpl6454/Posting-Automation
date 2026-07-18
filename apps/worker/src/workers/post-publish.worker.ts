import { Worker, type Job, UnrecoverableError } from "bullmq";
import { prisma } from "@postautomation/db";
import { getSocialProvider } from "@postautomation/social";
import { QUEUE_NAMES, postPublishQueue, analyticsSyncQueue, type PostPublishJobData, createRedisConnection } from "@postautomation/queue";
import IORedis from "ioredis";
import { buildPublishEmail, buildPublishReportCsv } from "../lib/publish-email";
import { markTargetFailed, buildPublishNotifications, mediaRequiredReason, terminalizeStuckClaim, isSeedNoise } from "../lib/publish-recovery";
import { PRIORITY_RETRY } from "../lib/publish-priority";

/** Integer env knob with a default and a sane clamp (bad values → default). */
function envInt(name: string, def: number, min: number, max: number): number {
  const parsed = parseInt(process.env[name] ?? "", 10);
  if (Number.isNaN(parsed)) return def;
  return Math.min(max, Math.max(min, parsed));
}

// Publishing is network-I/O-bound (platform API calls + media uploads), so a
// single Node process handles well above 3 concurrent publishes. Per-platform
// protection does NOT live here — it's the per-platform stagger
// (lib/publish-stagger.ts) + the reactive rate_limit reclassification below +
// the FB provider's own throttle backoff. This limiter is only a global safety
// valve; at 3/5s it was the cross-tenant choke point (36 starts/min for the
// whole platform, and three slow FB/YouTube jobs froze publishing for
// every org).
const PUBLISH_CONCURRENCY = envInt("PUBLISH_CONCURRENCY", 10, 1, 25);
const PUBLISH_LIMITER_MAX = envInt("PUBLISH_LIMITER_MAX", 10, 1, 50);

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
// every org OWNER/ADMIN — noisy). Per-channel rows with channel name/handle,
// UTC+IST timestamps, and the platform post URL. Template lives in
// ../lib/publish-email.ts (pure + unit-tested, HTML-escaped — the old inline
// template interpolated user content raw).
async function sendPublishReportEmail(
  organizationId: string,
  postId: string,
  postContent: string,
  allTargets: {
    status: string;
    publishedUrl: string | null;
    publishedAt: Date | null;
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
function classifyError(errMsg: string): "rate_limit" | "token_expired" | "permission" | "content_too_large" | "media_required" | "unknown" {
  const msg = errMsg.toLowerCase();
  if (msg.includes("limit how often") || msg.includes("rate limit") || msg.includes("too many") || msg.includes("code\":368") || msg.includes("code\":32")) return "rate_limit";
  if (msg.includes("token") && (msg.includes("expired") || msg.includes("invalid")) || msg.includes("code\":190") || msg.includes("401")) return "token_expired";
  if (msg.includes("permission") || msg.includes("code\":10") || msg.includes("403")) return "permission";
  if (msg.includes("reduce the amount") || msg.includes("too long") || msg.includes("too large") || msg.includes("content is too")) return "content_too_large";
  if (msg.includes("requires at least one image") || msg.includes("media required")) return "media_required";
  return "unknown";
}

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
  const worker = new Worker<PostPublishJobData>(
    QUEUE_NAMES.POST_PUBLISH,
    async (job: Job<PostPublishJobData>) => {
      const { postTargetId, channelId, platform } = job.data;
      console.log(`[PostPublish] Processing job ${job.id} for target ${postTargetId} (attempt ${job.attemptsMade + 1})`);

      // 0. Atomic idempotency claim — only transitions SCHEDULED/FAILED/DRAFT → PUBLISHING.
      // If the target is already PUBLISHING/PUBLISHED or doesn't exist, skip silently.
      const claim = await prisma.postTarget.updateMany({
        where: { id: postTargetId, status: { in: ["SCHEDULED", "FAILED", "DRAFT"] } },
        data: { status: "PUBLISHING" },
      });
      if (claim.count === 0) {
        // The claim guard only transitions SCHEDULED/FAILED/DRAFT → PUBLISHING.
        // count===0 means the target is already PUBLISHING/PUBLISHED or gone.
        // On a NON-final attempt we skip (a later attempt or the original job may
        // still finish). On the FINAL attempt a no-op claim means a previous
        // attempt left it orphaned at PUBLISHING — terminalize it now so it can't
        // sit "in progress" forever (the 30-min watchdog is the slow backstop).
        const isFinalAttempt = (job.attemptsMade + 1) >= (job.opts?.attempts ?? 1);
        if (terminalizeStuckClaim({ claimCount: claim.count, isFinalAttempt })) {
          const stuck = await prisma.postTarget.findUnique({
            where: { id: postTargetId },
            select: { status: true, publishedId: true },
          });
          // Only terminalize a target genuinely orphaned at PUBLISHING with no
          // platform id — never clobber a PUBLISHED row or one that has a
          // publishedId (the publishedId short-circuit will mark it PUBLISHED).
          if (stuck && stuck.status === "PUBLISHING" && !stuck.publishedId) {
            await markTargetFailed(
              prisma,
              postTargetId,
              "Publishing did not complete after all retries — please retry.",
            );
            console.warn(`[PostPublish] target ${postTargetId} orphaned at PUBLISHING on final attempt — marked FAILED (job ${job.id})`);
          }
        } else {
          console.warn(`[PostPublish] target ${postTargetId} already claimed or published — skipping duplicate job ${job.id}`);
        }
        return;
      }

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
            const clientId = process.env[`${platform}_CLIENT_ID`] || "";
            const clientSecret = process.env[`${platform}_CLIENT_SECRET`] || "";
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
      let mediaUrls = postTarget.post.mediaAttachments.map((m) => m.media.url);
      const mediaTypes = postTarget.post.mediaAttachments.map((m) => m.media.fileType);

      // Build merged provider metadata: post intent → target overrides → format → channel IDs (wins)
      const channelMetadata = (channel.metadata ?? {}) as Record<string, unknown>;
      const providerMetadata: Record<string, unknown> = {
        ...((postTarget.post.metadata as object) || {}),
        ...((postTarget.metadata as object) || {}),
        ...(postTarget.format ? { format: postTarget.format } : {}),
        ...channelMetadata, // pageId/igUserId/logo_path MUST win — kept last
      };

      // Auto-add channel logo watermark + optional text overlay on videos
      const hasVideo = mediaTypes.some((t) => t?.startsWith("video/"));
      if (hasVideo && ["INSTAGRAM", "FACEBOOK"].includes(platform)) {
        try {
          const { processVideoOverlay } = await import("../lib/video-overlay");

          // Resolve channel logo from Logo Library
          let logoUrl: string | null = null;
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

          const overlayText = (postTarget.post.metadata as any)?.videoOverlayText as string | undefined;

          const processed: string[] = [];
          for (let i = 0; i < mediaUrls.length; i++) {
            if (mediaTypes[i]?.startsWith("video/")) {
              console.log(`[PostPublish] Processing video ${i + 1}: logo=${logoUrl ? "yes" : "name"}, text=${overlayText ? "yes" : "no"}`);
              const newUrl = await processVideoOverlay(mediaUrls[i]!, {
                text: overlayText,
                textPosition: "bottom",
                textFontSize: 42,
                logoUrl,
                channelName: channel.name, // fallback watermark if no logo
                logoPosition: "bottom_right",
                logoSize: 120,
              });
              processed.push(newUrl);
            } else {
              processed.push(mediaUrls[i]!);
            }
          }
          mediaUrls = processed;
        } catch (e) {
          console.warn(`[PostPublish] Video overlay failed, posting without:`, (e as Error).message);
        }
      }

      // Auto-generate AI image for media-required platforms (Instagram, Facebook) if no media attached
      const mediaRequiredPlatforms = ["INSTAGRAM", "FACEBOOK"];
      if (mediaUrls.length === 0 && mediaRequiredPlatforms.includes(platform)) {
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
          const reason = mediaRequiredReason(platform);
          await markTargetFailed(prisma, postTargetId, reason);
          throw new UnrecoverableError(reason);
        }
        throw new Error(`Validation failed: ${errors.join(", ")}`);
      }

      let result;
      try {
        console.log(`[PostPublish] Publishing to ${platform} via ${provider.displayName} (mediaUrls: ${mediaUrls.length})`);

        // Build progress callback — only meaningful for media-heavy platforms (YouTube etc.)
        const onProgress = (percent: number) => reportProgress(postTargetId, percent);

        // Retry up to 3 times for transient network errors (fetch timeouts under heavy load)
        let lastErr: any;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            result = await provider.publishPost(tokens, { content: publishContent, mediaUrls, mediaTypes, metadata: providerMetadata, onProgress });
            lastErr = null;
            break;
          } catch (e: any) {
            lastErr = e;
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
            // fresh interactive + bulk work (lib/publish-priority.ts).
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
          try {
            const clientId = process.env[`${platform}_CLIENT_ID`] || "";
            const clientSecret = process.env[`${platform}_CLIENT_SECRET`] || "";
            if (clientId && clientSecret && channel.refreshToken) {
              const refreshed = await provider.refreshAccessToken(
                channel.refreshToken,
                { clientId, clientSecret, callbackUrl: `${process.env.APP_URL || ""}/api/oauth/callback/${platform.toLowerCase()}`, scopes: [] }
              );
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
                { content: publishContent, mediaUrls, mediaTypes, metadata: providerMetadata, onProgress: (percent: number) => reportProgress(postTargetId, percent) }
              );
              console.log(`[PostPublish] Retry with fresh token succeeded`);
            } else {
              throw publishErr; // Can't refresh — rethrow original error
            }
          } catch (refreshRetryErr: any) {
            // Mark FAILED before throwing — otherwise the target stays at PUBLISHING,
            // the BullMQ retry's claim guard skips it as a "duplicate" (claim.count === 0),
            // and it's orphaned at PUBLISHING forever. Mirrors the generic else branch below.
            const tokenErrMsg = `Token expired and refresh failed: ${refreshRetryErr.message}. Reconnect this channel in Settings.`;
            await markTargetFailed(prisma, postTargetId, tokenErrMsg);
            throw new Error(tokenErrMsg);
          }
        } else if (errType === "media_required") {
          // Media-required platform (IG/FB) with no usable media. Retrying re-runs
          // the same media-less input and fails identically; the retry's claim
          // guard would then skip it as a duplicate and orphan it at PUBLISHING.
          // Mark FAILED here with a clear human reason so the user knows to attach
          // media or enable AI image generation.
          const reason = mediaRequiredReason(platform);
          await markTargetFailed(prisma, postTargetId, reason);
          throw new UnrecoverableError(reason);
        } else if (errType === "content_too_large") {
          // Aggressively truncate and retry
          const aggressiveContent = truncateForPlatform(publishContent, platform);
          console.log(`[PostPublish] Content too large — retrying with aggressive truncation`);
          try {
            result = await provider.publishPost(tokens, { content: aggressiveContent.slice(0, Math.floor(aggressiveContent.length * 0.7)), mediaUrls, mediaTypes, metadata: providerMetadata });
          } catch (truncateRetryErr: any) {
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
                engagementRate: analytics.engagementRate ?? 0,
                metadata: analytics as any,
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
      if (result.platformPostId) {
        const AT_AGE_WINDOWS: Record<string, number> = {
          "24h": 86_400_000,
          "7d": 604_800_000,
          "15d": 1_296_000_000,
          "30d": 2_592_000_000,
        };
        for (const [windowTag, delay] of Object.entries(AT_AGE_WINDOWS)) {
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

      // 5. Check if all targets are published and update parent post (best-effort)
      try {
        const allTargets = await prisma.postTarget.findMany({
          where: { postId: postTarget.postId },
          include: { channel: { select: { platform: true, name: true, username: true } } },
        });
        const allPublished = allTargets.every((t) => t.status === "PUBLISHED");
        if (allPublished) {
          await prisma.post.update({
            where: { id: postTarget.postId },
            data: { status: "PUBLISHED", publishedAt: new Date() },
          });

          // Send email report with all published links
          await sendPublishReportEmail(postTarget.post.organizationId, postTarget.postId, postTarget.post.content, allTargets);
        }
      } catch (aggregateErr: any) {
        console.warn(`[PostPublish] Post aggregation step failed for ${postTargetId}: ${aggregateErr.message}`);
      }

      console.log(`[PostPublish] Successfully published ${postTargetId} to ${platform}`);
      return result;
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

  worker.on("failed", async (job, err) => {
    if (!job) return;
    try {
      const errType = classifyError(err.message);
      console.error(`[PostPublish] Job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts?.attempts ?? 1}, type: ${errType}):`, err.message);

      const isFinalAttempt = job.attemptsMade >= (job.opts?.attempts ?? 1);

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
  });

  worker.on("completed", (job) => {
    console.log(`[PostPublish] Job ${job.id} completed`);
  });

  return worker;
}
