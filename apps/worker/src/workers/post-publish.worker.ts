import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { getSocialProvider } from "@postautomation/social";
import { QUEUE_NAMES, type PostPublishJobData, createRedisConnection } from "@postautomation/queue";

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
              const refreshed = await provider.refreshAccessToken({
                accessToken: channel.accessToken,
                refreshToken: channel.refreshToken,
              }, {
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

      // Add text overlay to videos for Instagram and Facebook
      const overlayText = (postTarget.post.metadata as any)?.videoOverlayText as string | undefined;
      if (overlayText && mediaUrls.length > 0) {
        const overlayPlatforms = ["INSTAGRAM", "FACEBOOK"];
        if (overlayPlatforms.includes(platform)) {
          try {
            const { addTextOverlayToVideo } = await import("../lib/video-overlay");
            const processed: string[] = [];
            for (let i = 0; i < mediaUrls.length; i++) {
              if (mediaTypes[i]?.startsWith("video/")) {
                console.log(`[PostPublish] Adding text overlay to video ${i + 1}`);
                const newUrl = await addTextOverlayToVideo(mediaUrls[i]!, overlayText, {
                  position: "bottom",
                  fontSize: 42,
                });
                processed.push(newUrl);
              } else {
                processed.push(mediaUrls[i]!);
              }
            }
            mediaUrls = processed;
          } catch (e) {
            console.warn(`[PostPublish] Video overlay failed, posting without overlay:`, (e as Error).message);
          }
        }
      }

      // Validate content before publishing
      const errors = provider.validateContent({ content, mediaUrls, mediaTypes });
      if (errors.length > 0) {
        throw new Error(`Validation failed: ${errors.join(", ")}`);
      }

      // Pass channel metadata so providers can use platform-specific IDs
      // (e.g. igUserId for Instagram, pageId for Facebook)
      const channelMetadata = (channel.metadata ?? {}) as Record<string, unknown>;
      const result = await provider.publishPost(tokens, { content, mediaUrls, mediaTypes, metadata: channelMetadata });

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
      });
      const allPublished = allTargets.every((t) => t.status === "PUBLISHED");
      if (allPublished) {
        await prisma.post.update({
          where: { id: postTarget.postId },
          data: { status: "PUBLISHED", publishedAt: new Date() },
        });
      }

      console.log(`[PostPublish] Successfully published ${postTargetId} to ${platform}`);
      return result;
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
      limiter: { max: 10, duration: 1000 },
    }
  );

  worker.on("failed", async (job, err) => {
    console.error(`[PostPublish] Job ${job?.id} failed (attempt ${job?.attemptsMade}/${job?.opts?.attempts ?? 1}):`, err.message);
    if (job) {
      const isFinalAttempt = job.attemptsMade >= (job.opts?.attempts ?? 1);
      await prisma.postTarget.update({
        where: { id: job.data.postTargetId },
        data: {
          status: isFinalAttempt ? "FAILED" : "PUBLISHING",
          errorMessage: err.message,
          retryCount: { increment: 1 },
        },
      });

      // If this was the final attempt, check if ALL targets have failed/completed
      // and update parent post status accordingly
      if (isFinalAttempt) {
        const postTarget = await prisma.postTarget.findUnique({
          where: { id: job.data.postTargetId },
        });
        if (postTarget) {
          const allTargets = await prisma.postTarget.findMany({
            where: { postId: postTarget.postId },
          });
          const allDone = allTargets.every((t) => t.status === "PUBLISHED" || t.status === "FAILED");
          const allFailed = allTargets.every((t) => t.status === "FAILED");
          if (allDone) {
            await prisma.post.update({
              where: { id: postTarget.postId },
              data: { status: allFailed ? "FAILED" : "PUBLISHED" },
            });
          }
        }
      }
    }
  });

  worker.on("completed", (job) => {
    console.log(`[PostPublish] Job ${job.id} completed`);
  });

  return worker;
}
