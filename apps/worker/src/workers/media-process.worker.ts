import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { QUEUE_NAMES, type MediaProcessJobData, createRedisConnection } from "@postautomation/queue";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import {
  grabVideoFrame,
  planThumbnail,
  renderThumbnailWebp,
  thumbnailKey,
  THUMB_MAX_IMAGE_BYTES,
} from "../lib/media-thumbnail";

const s3 = new S3Client({
  region: process.env.S3_REGION || process.env.AWS_REGION || "us-east-1",
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: !!process.env.S3_ENDPOINT, // Required for MinIO
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

const S3_BUCKET = process.env.S3_BUCKET || "postautomation-media";
const S3_BASE_URL = process.env.S3_PUBLIC_URL || process.env.S3_BASE_URL || `https://${S3_BUCKET}.s3.amazonaws.com`;

async function downloadMedia(url: string, maxBytes?: number): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60_000), // 60s timeout for large files
  });
  if (!response.ok) {
    throw new Error(`Failed to download media: HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") || 0);
  if (maxBytes && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Media too large for processing (${declared} bytes)`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function uploadToS3(
  buffer: Buffer,
  key: string,
  contentType: string
): Promise<string> {
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000",
    })
  );
  return `${S3_BASE_URL}/${key}`;
}

function getContentType(fileType: string): string {
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
  };
  return map[fileType.toLowerCase()] || "application/octet-stream";
}

function generateS3Key(
  organizationId: string,
  mediaId: string,
  suffix: string,
  ext: string
): string {
  return `orgs/${organizationId}/media/${mediaId}/${suffix}.${ext}`;
}

/** Atomic jsonb merge of metadata.thumbnail — never rewrites the whole column (media-optimize writes it too). */
async function recordThumbnailState(mediaId: string, state: Record<string, unknown>): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE "Media"
      SET "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object('thumbnail', ${JSON.stringify(state)}::jsonb)
      WHERE "id" = ${mediaId}
    `;
  } catch (err) {
    console.warn(`[MediaProcess] could not record thumbnail state for ${mediaId}:`, (err as Error).message);
  }
}

/** WebP thumbnail (images: the file; videos: one frame). Null = nothing to make. */
async function processThumbnail(media: {
  id: string;
  url: string;
  fileType: string;
  fileSize: bigint;
  organizationId: string;
}): Promise<{ thumbnailUrl: string } | { skipped: string }> {
  const plan = planThumbnail(media);
  if (plan.kind === "skip") return { skipped: plan.reason };
  const source =
    plan.kind === "video" ? await grabVideoFrame(media.url) : await downloadMedia(media.url, THUMB_MAX_IMAGE_BYTES);
  const webp = await renderThumbnailWebp(source);
  const thumbnailUrl = await uploadToS3(webp, thumbnailKey(media.organizationId, media.id), "image/webp");
  return { thumbnailUrl };
}

async function processResize(
  imageBuffer: Buffer,
  media: { id: string; fileType: string; organizationId: string }
): Promise<{ url: string; width: number; height: number }> {
  // Resize to fit within 1920x1080 while maintaining aspect ratio
  const resized = sharp(imageBuffer).resize(1920, 1080, {
    fit: "inside",
    withoutEnlargement: true,
  });

  const metadata = await resized.toBuffer({ resolveWithObject: true });
  const { width, height } = metadata.info;

  const ext = media.fileType.includes("png") ? "png" : "jpg";
  const key = generateS3Key(media.organizationId, media.id, `resized_${width}x${height}`, ext);
  const contentType = getContentType(ext);
  const url = await uploadToS3(metadata.data, key, contentType);

  return { url, width, height };
}

async function processOptimize(
  imageBuffer: Buffer,
  media: { id: string; fileType: string; organizationId: string }
): Promise<{ url: string; fileSize: number }> {
  let pipeline = sharp(imageBuffer);
  let ext: string;

  if (media.fileType.includes("png")) {
    pipeline = pipeline.png({ compressionLevel: 6, quality: 80 });
    ext = "png";
  } else if (media.fileType.includes("webp")) {
    pipeline = pipeline.webp({ quality: 80 });
    ext = "webp";
  } else {
    // Default to JPEG optimization
    pipeline = pipeline.jpeg({ quality: 80, mozjpeg: true });
    ext = "jpg";
  }

  const optimized = await pipeline.toBuffer();

  const key = generateS3Key(media.organizationId, media.id, "optimized", ext);
  const contentType = getContentType(ext);
  const url = await uploadToS3(optimized, key, contentType);

  return { url, fileSize: optimized.length };
}

export function createMediaProcessWorker() {
  const worker = new Worker<MediaProcessJobData>(
    QUEUE_NAMES.MEDIA_PROCESS,
    async (job: Job<MediaProcessJobData>) => {
      const { mediaId, organizationId, operation } = job.data;
      console.log(`[MediaProcess] Processing job ${job.id}: ${operation} for media ${mediaId}`);

      // 1. Fetch media record from DB
      const media = await prisma.media.findUniqueOrThrow({
        where: { id: mediaId },
      });

      const mediaInfo = {
        id: media.id,
        fileType: media.fileType,
        organizationId,
      };

      if (operation === "thumbnail") {
        try {
          const result = await processThumbnail({ ...media, organizationId: media.organizationId });
          if ("skipped" in result) {
            await recordThumbnailState(mediaId, { status: "skipped", reason: result.skipped, at: new Date().toISOString() });
            return result;
          }
          await prisma.media.update({ where: { id: mediaId }, data: { thumbnailUrl: result.thumbnailUrl } });
          await recordThumbnailState(mediaId, { status: "done", at: new Date().toISOString() });
          return result;
        } catch (err) {
          // Only the final attempt marks it failed — the sweep never re-queues a failed one.
          if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
            await recordThumbnailState(mediaId, {
              status: "failed",
              error: (err as Error).message.slice(0, 200),
              at: new Date().toISOString(),
            });
          }
          throw err;
        }
      }

      // 2. Download the original media file
      console.log(`[MediaProcess] Downloading media from ${media.url}`);
      const imageBuffer = await downloadMedia(media.url);
      console.log(`[MediaProcess] Downloaded ${imageBuffer.length} bytes`);

      // 3. Process based on operation type
      switch (operation) {
        case "resize": {
          const result = await processResize(imageBuffer, mediaInfo);
          await prisma.media.update({
            where: { id: mediaId },
            data: {
              url: result.url,
              width: result.width,
              height: result.height,
            },
          });
          console.log(`[MediaProcess] Resized ${mediaId} to ${result.width}x${result.height}`);
          return result;
        }

        case "optimize": {
          const result = await processOptimize(imageBuffer, mediaInfo);
          await prisma.media.update({
            where: { id: mediaId },
            data: {
              url: result.url,
              fileSize: result.fileSize,
            },
          });
          console.log(`[MediaProcess] Optimized ${mediaId}: ${media.fileSize} -> ${result.fileSize} bytes`);
          return result;
        }

        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
    },
    {
      connection: createRedisConnection(),
      // 2 (was 3): the thumbnail sweep backfills existing media through this
      // worker, and sharp/ffmpeg share the 4-core box with publishing.
      concurrency: 2,
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 2000 },
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[MediaProcess] Job ${job?.id} failed (${job?.data.operation} for ${job?.data.mediaId}):`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[MediaProcess] Job ${job.id} completed (${job.data.operation} for ${job.data.mediaId})`);
  });

  return worker;
}
