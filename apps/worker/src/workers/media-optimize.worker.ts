import { Worker, type Job } from "bullmq";
import { execFile } from "child_process";
import { promisify } from "util";
import { createReadStream, promises as fsp } from "fs";
import os from "os";
import path from "path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "@postautomation/db";
import { QUEUE_NAMES, type MediaOptimizeJobData, createRedisConnection } from "@postautomation/queue";
import {
  evaluateOptimization,
  buildTranscodeArgs,
  type ProbeSummary,
  type OptimizeState,
} from "../lib/media-optimize";

/**
 * media-optimize worker: probes freshly-uploaded videos and, when they are
 * out of platform/browser spec (PCM/HEVC audio-video codecs, >1GB, extreme
 * bitrate, >1920 edges), produces ONE web-optimized H.264+AAC rendition next
 * to the original. Previews and IG/FB publishes use the rendition; YouTube
 * keeps the master. Decision logic + ffmpeg argv live in lib/media-optimize
 * (pure, tested).
 *
 * concurrency: 1 — a single ffmpeg saturates most of the 4-core prod box;
 * queued jobs simply wait their turn. ffmpeg reads the S3 URL directly (no
 * input download); only the output (≤~1GB) touches /tmp, and it is unlinked
 * in finally.
 */

const execFileAsync = promisify(execFile);

const s3 = new S3Client({
  region: process.env.S3_REGION || process.env.AWS_REGION || "us-east-1",
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: !!process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});
const S3_BUCKET = process.env.S3_BUCKET || "postautomation-media";
const S3_BASE_URL = process.env.S3_PUBLIC_URL || process.env.S3_BASE_URL || `https://${S3_BUCKET}.s3.amazonaws.com`;

const PROBE_TIMEOUT_MS = 60_000;
// A 15-min 1GB source at veryfast/1080p is well inside an hour on 3 threads.
const TRANSCODE_TIMEOUT_MS = Number(process.env.MEDIA_OPTIMIZE_TIMEOUT_MS || 60 * 60 * 1000);

/** Stream a (public S3) URL to a local file at full disk speed. */
async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`source download failed: HTTP ${res.status}`);
  const { Readable } = await import("stream");
  const { pipeline } = await import("stream/promises");
  const { createWriteStream } = await import("fs");
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(destPath));
}

async function probeMedia(url: string): Promise<ProbeSummary> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", url],
    { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
  );
  const data = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
    format?: { duration?: string; bit_rate?: string };
  };
  const v = data.streams?.find((s) => s.codec_type === "video");
  const a = data.streams?.find((s) => s.codec_type === "audio");
  return {
    videoCodec: v?.codec_name,
    audioCodec: a?.codec_name,
    width: v?.width,
    height: v?.height,
    durationSec: data.format?.duration ? parseFloat(data.format.duration) || undefined : undefined,
    bitrate: data.format?.bit_rate ? parseInt(data.format.bit_rate, 10) || undefined : undefined,
  };
}

async function writeOptimizeState(mediaId: string, baseMetadata: unknown, optimize: OptimizeState, columns?: Record<string, number>) {
  await prisma.media.update({
    where: { id: mediaId },
    data: {
      ...(columns ?? {}),
      // Prisma Json input typing rejects Record<string, unknown> — the value is a plain JSON object.
      metadata: { ...((baseMetadata as Record<string, unknown>) ?? {}), optimize } as any,
    },
  });
}

async function handleJob(job: Job<MediaOptimizeJobData>) {
  const media = await prisma.media.findUnique({ where: { id: job.data.mediaId } });
  if (!media || !media.fileType.startsWith("video/")) return;
  const existing = ((media.metadata as Record<string, unknown> | null)?.optimize ?? undefined) as OptimizeState | undefined;
  if (existing?.status === "done" || existing?.status === "skipped") return;
  const enqueuedAt = existing?.enqueuedAt ?? new Date().toISOString();

  try {
    const probe = await probeMedia(media.url);
    // Opportunistically fill the row's long-nullable dimension columns.
    const columns: Record<string, number> = {};
    if (media.width == null && probe.width) columns.width = probe.width;
    if (media.height == null && probe.height) columns.height = probe.height;
    if (media.duration == null && probe.durationSec) columns.duration = Math.round(probe.durationSec);

    const verdict = evaluateOptimization(probe, Number(media.fileSize));
    if (!verdict.needed) {
      await writeOptimizeState(media.id, media.metadata, { status: "skipped", probe, enqueuedAt }, columns);
      return;
    }

    await writeOptimizeState(media.id, media.metadata, { status: "processing", probe, reasons: verdict.reasons, enqueuedAt }, columns);
    const outPath = path.join(os.tmpdir(), `optimize-${media.id}.mp4`);
    const srcPath = path.join(os.tmpdir(), `optimize-src-${media.id}`);
    try {
      // Download the source to disk FIRST. ffmpeg reading the HTTP URL
      // directly gets silently TRUNCATED: the encode runs slower than
      // realtime, the input read stalls past nginx's send timeout, the
      // connection closes, and ffmpeg treats EOF as end-of-movie and exits 0
      // (live-caught 2026-07-21: 63s master → 40s rendition). A plain fetch
      // reads at disk speed with no encoder stalls.
      await downloadToFile(media.url, srcPath);
      await execFileAsync("ffmpeg", buildTranscodeArgs(srcPath, outPath), {
        timeout: TRANSCODE_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
      // Truncation guard: ffmpeg exit 0 does NOT prove the whole source was
      // consumed. A short output must never be published as "optimized".
      if (probe.durationSec && probe.durationSec > 1) {
        const out = await probeMedia(outPath);
        if (!out.durationSec || out.durationSec < probe.durationSec - Math.max(1, probe.durationSec * 0.02)) {
          throw new Error(
            `transcode truncated: output ${out.durationSec ?? 0}s vs source ${probe.durationSec}s`
          );
        }
      }
      const stat = await fsp.stat(outPath);
      const key = `optimized/${media.organizationId}/${media.id}.mp4`;
      await s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: createReadStream(outPath),
          ContentType: "video/mp4",
          ContentLength: stat.size,
          CacheControl: "public, max-age=86400",
        })
      );
      await writeOptimizeState(
        media.id,
        media.metadata,
        {
          status: "done",
          url: `${S3_BASE_URL}/${key}`,
          key,
          size: stat.size,
          reasons: verdict.reasons,
          probe,
          enqueuedAt,
        },
        columns
      );
      console.log(
        `[MediaOptimize] ${media.id} "${media.fileName}": ${(Number(media.fileSize) / 1e6).toFixed(0)}MB → ${(stat.size / 1e6).toFixed(0)}MB (${verdict.reasons.join("; ")})`
      );
    } finally {
      await fsp.unlink(outPath).catch(() => {});
      await fsp.unlink(srcPath).catch(() => {});
    }
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 400);
    console.error(`[MediaOptimize] ${media.id} failed:`, message);
    await writeOptimizeState(media.id, media.metadata, { status: "failed", error: message, enqueuedAt }).catch(() => {});
    throw err; // BullMQ retries (attempts set by the producer)
  }
}

export function createMediaOptimizeWorker() {
  const worker = new Worker<MediaOptimizeJobData>(QUEUE_NAMES.MEDIA_OPTIMIZE, handleJob, {
    connection: createRedisConnection(),
    concurrency: 1,
  });
  worker.on("failed", (job, err) => {
    console.error(`[MediaOptimize] Job ${job?.id} failed:`, err?.message);
  });
  return worker;
}
