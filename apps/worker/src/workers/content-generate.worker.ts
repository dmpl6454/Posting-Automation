import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import {
  QUEUE_NAMES,
  autopilotScheduleQueue,
  type ContentGenerateJobData,
  createRedisConnection,
} from "@postautomation/queue";
import {
  generateContent,
  suggestHashtags,
  generateNewsImage,
  type AIProvider,
} from "@postautomation/ai";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// ---------------------------------------------------------------------------
// S3 helpers (inline to avoid cross-package import issues in the worker)
// ---------------------------------------------------------------------------

function getS3Client(): S3Client {
  return new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: true,
    credentials: {
      accessKeyId:
        process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || "",
      secretAccessKey:
        process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || "",
    },
  });
}

const BUCKET = process.env.S3_BUCKET || "postautomation-media";

function getPublicUrl(key: string): string {
  if (process.env.S3_PUBLIC_URL) {
    return `${process.env.S3_PUBLIC_URL}/${key}`;
  }
  return `${process.env.S3_ENDPOINT || "https://s3.amazonaws.com"}/${BUCKET}/${key}`;
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

export function createContentGenerateWorker() {
  const worker = new Worker<ContentGenerateJobData>(
    QUEUE_NAMES.CONTENT_GENERATE,
    async (job: Job<ContentGenerateJobData>) => {
      const { autopilotPostId, organizationId, pipelineRunId } = job.data;
      console.log(
        `[ContentGenerate] Processing job ${job.id} for autopilotPost ${autopilotPostId}`,
      );

      try {
        // 1. Fetch AutopilotPost with relations; check idempotency
        const autopilotPost = await prisma.autopilotPost.findUnique({
          where: { id: autopilotPostId },
          include: {
            trendingItem: true,
            agent: { include: { accountGroup: true } },
          },
        });

        if (!autopilotPost) {
          console.log(
            `[ContentGenerate] AutopilotPost ${autopilotPostId} not found, skipping`,
          );
          return { skipped: true, reason: "not_found" };
        }

        // Idempotency: if a post is already linked, skip
        if (autopilotPost.postId) {
          console.log(
            `[ContentGenerate] AutopilotPost ${autopilotPostId} already has post ${autopilotPost.postId}, skipping`,
          );
          return { skipped: true, reason: "already_generated" };
        }

        const { trendingItem, agent } = autopilotPost;

        // 2. Update status to GENERATING
        await prisma.autopilotPost.update({
          where: { id: autopilotPostId },
          data: { status: "GENERATING" },
        });

        // 3. Generate caption
        const userPrompt = [
          `Write a social media post about this trending news:`,
          `Title: ${trendingItem.title}`,
          trendingItem.summary
            ? `Summary: ${trendingItem.summary}`
            : undefined,
          agent.niche ? `Niche/topic: ${agent.niche}` : undefined,
          agent.language !== "english"
            ? `Language: ${agent.language}`
            : undefined,
          agent.customPrompt
            ? `Additional instructions: ${agent.customPrompt}`
            : undefined,
        ]
          .filter(Boolean)
          .join("\n");

        const caption = await generateContent({
          provider: agent.aiProvider as AIProvider,
          platform: "instagram",
          userPrompt,
          tone: agent.tone,
        });

        // 4. Generate hashtags
        const hashtagList = await suggestHashtags({
          content: caption,
          platform: "instagram",
          provider: agent.aiProvider as AIProvider,
        });

        const hashtags = hashtagList.join(" ");

        // 5. Generate news card image
        let imageResult;
        try {
          imageResult = await generateNewsImage("news_card", {
            headline: trendingItem.title,
            source: trendingItem.sourceName,
            sourceUrl: trendingItem.sourceUrl,
            logoUrl: agent.referenceImageUrl ?? undefined,
            handle: agent.name,
            platform: "instagram",
          });
        } catch (imgErr) {
          // Fallback: try without logoUrl
          console.warn(
            `[ContentGenerate] Image generation failed with logoUrl, retrying without:`,
            imgErr,
          );
          imageResult = await generateNewsImage("news_card", {
            headline: trendingItem.title,
            source: trendingItem.sourceName,
            sourceUrl: trendingItem.sourceUrl,
            handle: agent.name,
            platform: "instagram",
          });
        }

        // 6. Upload image to S3
        const imageBuffer = Buffer.from(imageResult.imageBase64, "base64");
        const s3Key = `autopilot/${organizationId}/${autopilotPostId}.png`;

        const s3 = getS3Client();
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: s3Key,
            Body: imageBuffer,
            ContentType: imageResult.mimeType,
            ContentLength: imageBuffer.length,
          }),
        );

        const publicUrl = getPublicUrl(s3Key);

        // 7. Create Media record
        const media = await prisma.media.create({
          data: {
            organizationId,
            uploadedById: "autopilot-system",
            fileName: `news-${autopilotPostId}.png`,
            fileType: "image/png",
            fileSize: imageBuffer.length,
            url: publicUrl,
            width: imageResult.width,
            height: imageResult.height,
          },
        });

        // 8. Create Post record
        const fullContent = `${caption}\n\n${hashtags}`;
        const post = await prisma.post.create({
          data: {
            organizationId,
            createdById: "autopilot-system",
            content: fullContent,
            status: "DRAFT",
            aiGenerated: true,
            aiProvider: agent.aiProvider,
            aiPrompt: userPrompt,
          },
        });

        // 9. Create PostMedia record
        await prisma.postMedia.create({
          data: {
            postId: post.id,
            mediaId: media.id,
            order: 0,
          },
        });

        // 10. Create PostTarget records for each active channel
        const channels = await prisma.channel.findMany({
          where: {
            id: { in: agent.channelIds },
            isActive: true,
          },
        });

        for (const channel of channels) {
          await prisma.postTarget.create({
            data: {
              postId: post.id,
              channelId: channel.id,
              status: "DRAFT",
            },
          });
        }

        // 11. Determine review status
        const skipReview =
          agent.accountGroup?.skipReviewGate ||
          autopilotPost.sensitivity === "LOW";
        const finalStatus = skipReview ? "APPROVED" : "REVIEWING";

        // 12. Update AutopilotPost with postId and finalStatus
        await prisma.autopilotPost.update({
          where: { id: autopilotPostId },
          data: {
            postId: post.id,
            status: finalStatus,
          },
        });

        // 13. If APPROVED, queue AUTOPILOT_SCHEDULE job
        if (finalStatus === "APPROVED") {
          await autopilotScheduleQueue.add(
            `schedule-${autopilotPostId}`,
            {
              autopilotPostId,
              organizationId,
              pipelineRunId,
            },
            {
              removeOnComplete: true,
              removeOnFail: 100,
            },
          );
        }

        // 14. Update PipelineRun counters
        await prisma.pipelineRun.update({
          where: { id: pipelineRunId },
          data: {
            postsGenerated: { increment: 1 },
            ...(finalStatus === "APPROVED"
              ? { postsApproved: { increment: 1 } }
              : {}),
          },
        });

        console.log(
          `[ContentGenerate] Done. Post ${post.id} created for autopilotPost ${autopilotPostId} (status: ${finalStatus})`,
        );

        return {
          postId: post.id,
          autopilotPostId,
          status: finalStatus,
          channelCount: channels.length,
        };
      } catch (error: any) {
        // 15. On error: set AutopilotPost status to FAILED with errorMessage
        console.error(
          `[ContentGenerate] Job ${job.id} processing error:`,
          error.message,
        );

        try {
          await prisma.autopilotPost.update({
            where: { id: autopilotPostId },
            data: {
              status: "FAILED",
              errorMessage: error.message?.slice(0, 2000) || "Unknown error",
            },
          });

          await prisma.pipelineRun.update({
            where: { id: pipelineRunId },
            data: {
              postsFailed: { increment: 1 },
            },
          });
        } catch (updateErr) {
          console.error(
            `[ContentGenerate] Failed to update error status:`,
            updateErr,
          );
        }

        throw error;
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 10,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[ContentGenerate] Job ${job?.id} failed:`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[ContentGenerate] Job ${job.id} completed`);
  });

  return worker;
}
