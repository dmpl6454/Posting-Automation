import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { getSocialProvider } from "@postautomation/social";
import { QUEUE_NAMES, type PostPublishJobData, createRedisConnection } from "@postautomation/queue";

export function createPostPublishWorker() {
  const worker = new Worker<PostPublishJobData>(
    QUEUE_NAMES.POST_PUBLISH,
    async (job: Job<PostPublishJobData>) => {
      const { postTargetId, channelId, platform } = job.data;
      console.log(`[PostPublish] Processing job ${job.id} for target ${postTargetId}`);

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

      // 3. Get provider and publish
      const provider = getSocialProvider(platform as any);
      const tokens = {
        accessToken: channel.accessToken,
        refreshToken: channel.refreshToken ?? undefined,
      };

      // Use platform-specific content variant if available
      const contentVariants = postTarget.post.contentVariants as Record<string, string> | null;
      const content = contentVariants?.[platform] ?? postTarget.post.content;
      const mediaUrls = postTarget.post.mediaAttachments.map((m) => m.media.url);

      // Validate content before publishing
      const errors = provider.validateContent({ content, mediaUrls });
      if (errors.length > 0) {
        throw new Error(`Validation failed: ${errors.join(", ")}`);
      }

      const result = await provider.publishPost(tokens, { content, mediaUrls });

      // 4. Mark as PUBLISHED
      await prisma.postTarget.update({
        where: { id: postTargetId },
        data: {
          status: "PUBLISHED",
          publishedId: result.platformPostId,
          publishedUrl: result.url,
          publishedAt: new Date(),
          metadata: (result.metadata ?? undefined) as any,
        },
      });

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
    console.error(`[PostPublish] Job ${job?.id} failed:`, err.message);
    if (job) {
      await prisma.postTarget.update({
        where: { id: job.data.postTargetId },
        data: {
          status: "FAILED",
          errorMessage: err.message,
          retryCount: { increment: 1 },
        },
      });
    }
  });

  worker.on("completed", (job) => {
    console.log(`[PostPublish] Job ${job.id} completed`);
  });

  return worker;
}
