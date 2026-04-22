import { Worker, type Job, UnrecoverableError } from "bullmq";
import { prisma } from "@postautomation/db";
import { getSocialProvider } from "@postautomation/social";
import { QUEUE_NAMES, postPublishQueue, type PostPublishJobData, createRedisConnection } from "@postautomation/queue";

// ── Email report after all targets complete ────────────────────────────
async function sendPublishReportEmail(
  organizationId: string,
  postId: string,
  postContent: string,
  allTargets: { status: string; publishedUrl: string | null; channel: { platform: string } }[]
) {
  try {
    // Get org owner/admin emails
    const members = await prisma.organizationMember.findMany({
      where: { organizationId, role: { in: ["OWNER", "ADMIN"] } },
      include: { user: { select: { email: true, name: true } } },
    });

    if (members.length === 0) return;

    // Build target summary
    const targets = allTargets.map((t) => ({
      platform: t.channel.platform,
      url: t.publishedUrl,
      status: t.status,
    }));

    const postTitle = postContent.split("\n")[0]?.slice(0, 120) || "Untitled Post";
    const dashboardUrl = `${process.env.APP_URL || "http://localhost:3000"}/dashboard/posts/${postId}`;

    // Build email HTML inline (avoid cross-package dependency)
    const published = targets.filter((t) => t.status === "PUBLISHED");
    const failed = targets.filter((t) => t.status === "FAILED");
    const summary = `${published.length} published${failed.length ? `, ${failed.length} failed` : ""} across ${targets.length} platform${targets.length > 1 ? "s" : ""}`;

    const linkRows = published
      .map(
        (t) =>
          `<tr>
            <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;color:#18181b;font-weight:500;">${t.platform}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #e4e4e7;">
              ${t.url ? `<a href="${t.url}" style="color:#2563eb;text-decoration:none;">${t.url}</a>` : '<span style="color:#a1a1aa;">No link available</span>'}
            </td>
          </tr>`
      )
      .join("");

    const failedSection = failed.length
      ? `<div style="margin-top:20px;padding:12px 16px;background:#fef2f2;border-radius:6px;border-left:3px solid #ef4444;">
          <p style="margin:0 0 4px;font-weight:500;color:#991b1b;">Failed platforms:</p>
          <p style="margin:0;color:#991b1b;font-size:13px;">${failed.map((t) => t.platform).join(", ")}</p>
        </div>`
      : "";

    const subject = `Post Published: ${postTitle.slice(0, 60)}${postTitle.length > 60 ? "..." : ""}`;

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="background:#18181b;padding:24px 32px;">
      <h1 style="margin:0;color:#fff;font-size:20px;font-weight:600;">PostAutomation</h1>
    </div>
    <div style="padding:32px;">
      <h2 style="margin:0 0 8px;font-size:18px;color:#18181b;">Post Published</h2>
      <p style="color:#3f3f46;line-height:1.6;margin:0 0 4px;"><strong>${postTitle.length > 120 ? postTitle.slice(0, 120) + "..." : postTitle}</strong></p>
      <p style="color:#71717a;font-size:13px;margin:0 0 20px;">${summary}</p>
      ${published.length > 0 ? `
      <table style="width:100%;border-collapse:collapse;border:1px solid #e4e4e7;border-radius:6px;overflow:hidden;">
        <thead>
          <tr style="background:#f4f4f5;">
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#71717a;font-weight:500;">Platform</th>
            <th style="padding:10px 12px;text-align:left;font-size:13px;color:#71717a;font-weight:500;">Link</th>
          </tr>
        </thead>
        <tbody>${linkRows}</tbody>
      </table>` : ""}
      ${failedSection}
      <div style="text-align:center;margin:24px 0;">
        <a href="${dashboardUrl}" style="display:inline-block;background:#18181b;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:500;">View in Dashboard</a>
      </div>
    </div>
    <div style="padding:16px 32px;background:#f4f4f5;text-align:center;font-size:12px;color:#71717a;">
      <p style="margin:0;">&copy; ${new Date().getFullYear()} PostAutomation. All rights reserved.</p>
    </div>
  </div>
</body></html>`;

    const text = `Post Published: ${postTitle}\n\n${summary}\n\n${published.map((t) => `${t.platform}: ${t.url || "No link"}`).join("\n")}${failed.length ? `\n\nFailed: ${failed.map((t) => t.platform).join(", ")}` : ""}\n\nDashboard: ${dashboardUrl}`;

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

    for (const member of members) {
      if (!member.user.email) continue;
      if (transport) {
        await transport.sendMail({ from, to: member.user.email, subject, html, text });
        console.log(`[PostPublish] Email report sent to ${member.user.email}`);
      } else {
        console.log(`[PostPublish] [Email Preview] To: ${member.user.email} | Subject: ${subject}`);
        console.log(`[PostPublish] Links: ${published.map((t) => `${t.platform}: ${t.url}`).join(", ")}`);
      }
    }
  } catch (emailErr: any) {
    // Never let email failure break the publish flow
    console.warn(`[PostPublish] Email report failed:`, emailErr.message);
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

      // 1. Mark as PUBLISHING
      await prisma.postTarget.update({
        where: { id: postTargetId },
        data: { status: "PUBLISHING" },
      });

      // 2. Get channel and post data
      const [channel, postTarget] = await Promise.all([
        prisma.channel.findUniqueOrThrow({ where: { id: channelId } }),
        prisma.postTarget.findUniqueOrThrow({
          where: { id: postTargetId },
          include: {
            post: {
              include: { mediaAttachments: { include: { media: true }, orderBy: { order: "asc" } } },
            },
          },
        }),
      ]);

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

      // Use platform-specific content variant if available
      const contentVariants = postTarget.post.contentVariants as Record<string, string> | null;
      const content = contentVariants?.[platform] ?? postTarget.post.content;
      let mediaUrls = postTarget.post.mediaAttachments.map((m) => m.media.url);
      const mediaTypes = postTarget.post.mediaAttachments.map((m) => m.media.fileType);

      // Pass channel metadata so providers can use platform-specific IDs
      // (e.g. igUserId for Instagram, pageId for Facebook)
      const channelMetadata = (channel.metadata ?? {}) as Record<string, unknown>;

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
        throw new Error(`Validation failed: ${errors.join(", ")}`);
      }

      let result;
      try {
        console.log(`[PostPublish] Publishing to ${platform} via ${provider.displayName} (mediaUrls: ${mediaUrls.length})`);

        // Retry up to 3 times for transient network errors (fetch timeouts under heavy load)
        let lastErr: any;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            result = await provider.publishPost(tokens, { content: publishContent, mediaUrls, mediaTypes, metadata: channelMetadata });
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
            { delay: delayMs, attempts: 3, backoff: { type: "exponential", delay: 60_000 } }
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
                { content: publishContent, mediaUrls, mediaTypes, metadata: channelMetadata }
              );
              console.log(`[PostPublish] Retry with fresh token succeeded`);
            } else {
              throw publishErr; // Can't refresh — rethrow original error
            }
          } catch (refreshRetryErr: any) {
            // Mark with clear message about token issue
            throw new Error(`Token expired and refresh failed: ${refreshRetryErr.message}. Reconnect this channel in Settings.`);
          }
        } else if (errType === "content_too_large") {
          // Aggressively truncate and retry
          const aggressiveContent = truncateForPlatform(publishContent, platform);
          console.log(`[PostPublish] Content too large — retrying with aggressive truncation`);
          result = await provider.publishPost(tokens, { content: aggressiveContent.slice(0, Math.floor(aggressiveContent.length * 0.7)), mediaUrls, mediaTypes, metadata: channelMetadata });
        } else {
          throw publishErr; // Unknown or unrecoverable — rethrow
        }
      }

      if (!result) {
        throw new Error("Publish returned no result");
      }

      // 4. Mark as PUBLISHED
      const updatedTarget = await prisma.postTarget.update({
        where: { id: postTargetId },
        data: {
          status: "PUBLISHED",
          publishedId: result.platformPostId,
          publishedUrl: result.url,
          publishedAt: new Date(),
          metadata: (result.metadata ?? undefined) as any,
        },
      });

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

      // 5. Check if all targets are published and update parent post
      const allTargets = await prisma.postTarget.findMany({
        where: { postId: postTarget.postId },
        include: { channel: { select: { platform: true } } },
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

      console.log(`[PostPublish] Successfully published ${postTargetId} to ${platform}`);
      return result;
    },
    {
      connection: createRedisConnection(),
      concurrency: 3,
      limiter: { max: 3, duration: 5000 }, // max 3 publishes per 5 seconds to avoid rate limits
    }
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
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

    await prisma.postTarget.update({
      where: { id: job.data.postTargetId },
      data: {
        status: isFinalAttempt ? "FAILED" : "PUBLISHING",
        errorMessage: userMessage,
        retryCount: { increment: 1 },
      },
    });

    // Log to ErrorLog for monitoring dashboard
    if (isFinalAttempt) {
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
      } catch { /* never let monitoring break the worker */ }
    }

      // If this was the final attempt, check if ALL targets have failed/completed
      // and update parent post status accordingly
      if (isFinalAttempt) {
        const postTarget = await prisma.postTarget.findUnique({
          where: { id: job.data.postTargetId },
          include: { post: { select: { content: true, organizationId: true } } },
        });
        if (postTarget) {
          const allTargets = await prisma.postTarget.findMany({
            where: { postId: postTarget.postId },
            include: { channel: { select: { platform: true } } },
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
      }
  });

  worker.on("completed", (job) => {
    console.log(`[PostPublish] Job ${job.id} completed`);
  });

  return worker;
}
