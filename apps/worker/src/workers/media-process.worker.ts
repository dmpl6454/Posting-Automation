import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { QUEUE_NAMES, type MediaProcessJobData, createRedisConnection } from "@postautomation/queue";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";

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

async function downloadMedia(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60_000), // 60s timeout for large files
  });
  if (!response.ok) {
    throw new Error(`Failed to download media: HTTP ${response.status}`);
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

async function processThumbnail(
  imageBuffer: Buffer,
  media: { id: string; fileType: string; organizationId: string }
): Promise<{ thumbnailUrl: string; width: number; height: number }> {
  const thumbnail = await sharp(imageBuffer)
    .resize(400, 400, { fit: "cover", position: "centre" })
    .toBuffer();

  const ext = media.fileType.includes("png") ? "png" : "jpg";
  const key = generateS3Key(media.organizationId, media.id, "thumb_400x400", ext);
  const contentType = getContentType(ext);
  const thumbnailUrl = await uploadToS3(thumbnail, key, contentType);

  return { thumbnailUrl, width: 400, height: 400 };
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

      // 2. Download the original media file
      console.log(`[MediaProcess] Downloading media from ${media.url}`);
      const imageBuffer = await downloadMedia(media.url);
      console.log(`[MediaProcess] Downloaded ${imageBuffer.length} bytes`);

      const mediaInfo = {
        id: media.id,
        fileType: media.fileType,
        organizationId,
      };

      // 3. Process based on operation type
      switch (operation) {
        case "thumbnail": {
          const result = await processThumbnail(imageBuffer, mediaInfo);
          await prisma.media.update({
            where: { id: mediaId },
            data: { thumbnailUrl: result.thumbnailUrl },
          });
          console.log(`[MediaProcess] Thumbnail created for ${mediaId}: ${result.thumbnailUrl}`);
          return result;
        }

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
      concurrency: 3, // Limit concurrency — media processing is CPU/memory intensive
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
