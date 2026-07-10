import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import {
  QUEUE_NAMES,
  autopilotScheduleQueue,
  type ContentGenerateJobData,
  createRedisConnection,
} from "@postautomation/queue";
import { resolveOrgAuthor } from "../lib/system-user";
import { deriveRunStatus } from "./lib/run-status";
import {
  generateContent,
  suggestHashtags,
  generateNewsImage,
  generateStaticNewsCreativeImage,
  generateRelevantBackground,
  extractDominantColor,
  withTextProviderFallback,
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

        // Resolve a real org member to attribute generated content to
        const authorId = await resolveOrgAuthor(organizationId);

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

        // Resilient text generation: [agent's provider → openai → anthropic],
        // skipping unconfigured keys — an agent configured with a billing-held
        // provider (e.g. gemini) no longer hard-fails every autopilot run.
        const caption = await withTextProviderFallback(
          agent.aiProvider,
          (p) =>
            generateContent({
              provider: p as AIProvider,
              platform: "instagram",
              userPrompt,
              tone: agent.tone,
            }),
          (failed, next, e) =>
            console.warn(`[ContentGenerate] Caption via ${failed} failed (${e instanceof Error ? e.message.slice(0, 80) : e}), trying ${next}`),
        );

        // 4. Generate hashtags
        const hashtagList = await withTextProviderFallback(
          agent.aiProvider,
          (p) =>
            suggestHashtags({
              content: caption,
              platform: "instagram",
              provider: p as AIProvider,
            }),
          (failed, next, e) =>
            console.warn(`[ContentGenerate] Hashtags via ${failed} failed (${e instanceof Error ? e.message.slice(0, 80) : e}), trying ${next}`),
        );

        const hashtags = hashtagList.join(" ");

        // 5. Generate news creative image with AI-generated relevant background
        let imageResult;
        try {
          // Extract brand color from logo
          const logoUrl = agent.referenceImageUrl ?? undefined;
          let brandColor: string | null = null;
          if (logoUrl) {
            try { brandColor = await extractDominantColor(logoUrl); } catch { /* use default */ }
          }

          // Generate a relevant background image using DALL-E
          const bgImageUrl = await generateRelevantBackground(trendingItem.title);

          imageResult = await generateStaticNewsCreativeImage({
            headline: trendingItem.title,
            channelName: agent.name,
            handle: agent.name,
            logoUrl,
            template: "cinematic",
            backgroundImageUrl: bgImageUrl || undefined,
            date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
            ...(brandColor && { brandColor }),
          });
        } catch (imgErr) {
          // Fallback: basic news card without AI background
          console.warn(
            `[ContentGenerate] Static creative failed, falling back to news card:`,
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
            uploadedById: authorId,
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
            createdById: authorId,
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

        let createdTargets = 0;
        for (const channel of channels) {
          // Autopilot generates still images only, never video. YouTube requires a
          // video file to publish, so an image-only YouTube target always fails at
          // publish time. Skip it until autopilot can produce video.
          if (channel.platform === "YOUTUBE") {
            console.warn(
              `[ContentGenerate] Skipping YOUTUBE channel ${channel.id} — autopilot produces images, not video`
            );
            continue;
          }
          await prisma.postTarget.create({
            data: {
              postId: post.id,
              channelId: channel.id,
              status: "DRAFT",
            },
          });
          createdTargets++;
        }

        // BUG-06: If every channel was skipped (e.g. a YouTube-only agent —
        // autopilot can't post video), the post has zero PostTargets and can
        // never publish. Don't leave a dangling "publishable" post: mark both
        // the Post and the AutopilotPost FAILED with a clear reason, count it
        // toward the run as a failure, and stop here so we don't queue a
        // schedule job for an unpublishable post.
        if (createdTargets === 0) {
          const reason =
            "No publishable channels: autopilot produces images, but the agent's only channels need video (e.g. YouTube). Add an image-capable channel or enable video generation.";
          console.warn(
            `[ContentGenerate] Agent ${agent.id} produced a post with no publishable channels; marking FAILED. ${reason}`,
          );
          await prisma.post.update({
            where: { id: post.id },
            data: { status: "FAILED" },
          });
          await prisma.autopilotPost.update({
            where: { id: autopilotPostId },
            data: {
              status: "FAILED",
              errorMessage: reason.slice(0, 2000),
            },
          });
          // Count this item as failed so the run's completion math still
          // reaches totalItems (ADD-1), then settle the run if appropriate.
          try {
            const updated = await prisma.pipelineRun.update({
              where: { id: pipelineRunId },
              data: { postsFailed: { increment: 1 } },
            });
            const done = updated.postsGenerated + updated.postsFailed;
            const scoringDone = updated.itemsScored >= updated.itemsDiscovered;
            if (
              scoringDone &&
              updated.totalItems > 0 &&
              done >= updated.totalItems &&
              updated.status === "RUNNING"
            ) {
              const settledStatus = deriveRunStatus(updated);
              await prisma.pipelineRun.update({
                where: { id: pipelineRunId },
                data: { status: settledStatus, completedAt: new Date() },
              });
              console.log(
                `[ContentGenerate] Pipeline ${pipelineRunId} ${settledStatus} (${done}/${updated.totalItems} items)`,
              );
            }
          } catch {}

          return {
            postId: post.id,
            autopilotPostId,
            status: "FAILED",
            channelCount: 0,
            reason,
          };
        }

        // 11. Determine review status
        // Auto-approval is governed ONLY by the account group's explicit
        // skipReviewGate opt-in. Sensitivity is advisory metadata and must NOT
        // bypass review — a LOW classification (also the classifier's default
        // when no keywords match) previously auto-approved nearly every post.
        const skipReview = agent.accountGroup?.skipReviewGate === true;
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

        // 14. Update PipelineRun counters; mark COMPLETED if all items are done
        try {
          const updated = await prisma.pipelineRun.update({
            where: { id: pipelineRunId },
            data: {
              postsGenerated: { increment: 1 },
              ...(finalStatus === "APPROVED"
                ? { postsApproved: { increment: 1 } }
                : {}),
            },
          });
          const done = updated.postsGenerated + updated.postsFailed;
          // Only complete once scoring has finished (itemsScored >=
          // itemsDiscovered) so totalItems is final — trend-score accumulates
          // totalItems as it matches items, so completing on a partial total
          // would close the run early (ADD-1). If a generate job finishes after
          // scoring is already done, this closes the run; otherwise the last
          // trend-score job closes it.
          const scoringDone = updated.itemsScored >= updated.itemsDiscovered;
          if (
            scoringDone &&
            updated.totalItems > 0 &&
            done >= updated.totalItems &&
            updated.status === "RUNNING"
          ) {
            const settledStatus = deriveRunStatus(updated);
            await prisma.pipelineRun.update({
              where: { id: pipelineRunId },
              data: { status: settledStatus, completedAt: new Date() },
            });
            console.log(`[ContentGenerate] Pipeline ${pipelineRunId} ${settledStatus} (${done}/${updated.totalItems} items)`);
          }
        } catch {}


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

          try {
            const updated = await prisma.pipelineRun.update({
              where: { id: pipelineRunId },
              data: { postsFailed: { increment: 1 } },
            });
            const done = updated.postsGenerated + updated.postsFailed;
            // See success-path note: gate completion on scoring being finished
            // so totalItems is final before we close the run (ADD-1).
            const scoringDone = updated.itemsScored >= updated.itemsDiscovered;
            if (
              scoringDone &&
              updated.totalItems > 0 &&
              done >= updated.totalItems &&
              updated.status === "RUNNING"
            ) {
              const settledStatus = deriveRunStatus(updated);
              await prisma.pipelineRun.update({
                where: { id: pipelineRunId },
                data: { status: settledStatus, completedAt: new Date() },
              });
              console.log(`[ContentGenerate] Pipeline ${pipelineRunId} ${settledStatus} (${done}/${updated.totalItems} items)`);
            }
          } catch {}
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
