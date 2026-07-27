import { Worker, type Job } from "bullmq";
import { execFile } from "child_process";
import { promisify } from "util";
import { createReadStream, promises as fsp } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "@postautomation/db";
import {
  QUEUE_NAMES,
  mediaOptimizeQueue,
  createRedisConnection,
  type SuperTextBurnJobData,
} from "@postautomation/queue";
import { buildSuperTextFrameHtml, superTextConfigSchema } from "@postautomation/super-text";
import { launchCreativeBrowser } from "@postautomation/ai";
import { buildSuperTextCompositeArgs, durationIntegrityOk } from "../lib/super-text-burn";
import { flipParkedPostIfReady } from "../lib/publish-gates";

/**
 * super-text worker: burns the user's positioned text strip into their video
 * BEFORE it publishes.
 *
 * Pipeline per configured video:
 *   1. ffprobe the source for its native pixel size + duration
 *   2. render the strip to a TRANSPARENT full-frame PNG via the shared HTML
 *      builder + the gated Puppeteer browser (Chromium is what gives us colour
 *      emoji and per-word colours — ffmpeg drawtext can do neither)
 *   3. stream the source to /tmp, then ffmpeg `overlay=0:0`
 *   4. verify the output wasn't truncated, upload it, create a DERIVED Media row
 *   5. repoint the post's PostMedia at the derived row
 * Then clear the gate and flip DRAFT→SCHEDULED if nothing else is pending.
 *
 * Because step 5 leaves an ordinary video Media row attached to the post, the
 * frozen IG/FB publish paths, media-optimize, streamed uploads and the watchdog
 * all continue to work with ZERO changes.
 *
 * concurrency: 1 — one ffmpeg at a time on the 4-core prod box, matching
 * media-optimize. Puppeteer is additionally bounded by CREATIVE_RENDER_CONCURRENCY
 * inside launchCreativeBrowser.
 */

const execFileAsync = promisify(execFile);

const s3 = new S3Client({
  region: process.env.S3_REGION || process.env.AWS_REGION || "us-east-1",
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: !!process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId:
      process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey:
      process.env.S3_SECRET_ACCESS_KEY ||
      process.env.S3_SECRET_KEY ||
      process.env.AWS_SECRET_ACCESS_KEY ||
      "",
  },
});
const S3_BUCKET = process.env.S3_BUCKET || "postautomation-media";
const S3_BASE_URL =
  process.env.S3_PUBLIC_URL || process.env.S3_BASE_URL || `https://${S3_BUCKET}.s3.amazonaws.com`;

const PROBE_TIMEOUT_MS = 60_000;
const BURN_TIMEOUT_MS = Number(process.env.SUPER_TEXT_TIMEOUT_MS || 30 * 60 * 1000);
/** Re-check of the create-time cap (SUPER_TEXT_MAX_SOURCE_BYTES in packages/api). */
const MAX_SOURCE_BYTES = 950 * 1024 * 1024;

export const SUPER_TEXT_FAIL_MESSAGE =
  "Super text could not be applied to your video. Edit the post to try again, or remove the super text.";

interface Probe {
  width?: number;
  height?: number;
  durationSec?: number;
}

async function probe(target: string): Promise<Probe> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", target],
    { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
  );
  const data = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    format?: { duration?: string };
  };
  const v = data.streams?.find((s) => s.codec_type === "video");
  return {
    width: v?.width,
    height: v?.height,
    durationSec: data.format?.duration ? parseFloat(data.format.duration) || undefined : undefined,
  };
}

/** Stream a (public S3) URL to a local file — never buffer a video in heap. */
async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`source download failed: HTTP ${res.status}`);
  const { Readable } = await import("stream");
  const { pipeline } = await import("stream/promises");
  const { createWriteStream } = await import("fs");
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(destPath));
}

/** Render the strip as a transparent full-frame PNG at the video's native size. */
async function renderStripPng(html: string, width: number, height: number, outPath: string) {
  const browser = await launchCreativeBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    // `load` (not networkidle0) — the page is fully self-contained inline HTML.
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    const png = (await page.screenshot({
      type: "png",
      omitBackground: true, // transparency is what makes overlay=0:0 work
      encoding: "base64",
    })) as string;
    await fsp.writeFile(outPath, Buffer.from(png, "base64"));
  } finally {
    // Closing releases the CREATIVE_RENDER_CONCURRENCY slot.
    await browser.close().catch(() => undefined);
  }
}

/** Merge-patch `metadata.superText` on the post (fresh read → additive write). */
async function stampSuperText(postId: string, patch: Record<string, unknown>) {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { metadata: true } });
  const meta = ((post?.metadata as Record<string, unknown>) ?? {});
  const st = ((meta.superText as Record<string, unknown>) ?? {});
  await prisma.post.update({
    where: { id: postId },
    data: { metadata: { ...meta, superText: { ...st, ...patch } } as any },
  });
}

/**
 * FAIL-VISIBLE terminal path. Unlike caption-fanout's degraded valve (publishing a
 * shared caption is an acceptable fallback), publishing a video WITHOUT the text
 * the user deliberately placed changes the meaning of the post — so a burn that
 * exhausts its retries fails the post loudly instead. Org-scoped and idempotent.
 */
export async function markSuperTextFailed(
  postId: string,
  organizationId: string,
  errorDetail: string
): Promise<void> {
  const post = await prisma.post.findFirst({
    where: { id: postId, organizationId },
    select: { id: true, metadata: true },
  });
  if (!post) return;
  const meta = ((post.metadata as Record<string, unknown>) ?? {});
  const st = ((meta.superText as Record<string, any>) ?? {});
  if (st.pendingBurn !== true) return; // already resolved — never double-fail

  await prisma.postTarget.updateMany({
    where: { postId, status: { in: ["DRAFT", "SCHEDULED"] } },
    data: { status: "FAILED", errorMessage: SUPER_TEXT_FAIL_MESSAGE },
  });
  await prisma.post.update({
    where: { id: postId },
    data: {
      status: "FAILED",
      metadata: {
        ...meta,
        superText: {
          ...st,
          pendingBurn: false,
          failed: true,
          error: String(errorDetail).slice(0, 300),
          completedAt: new Date().toISOString(),
        },
      } as any,
    },
  });
}

export async function runSuperTextBurn(
  data: SuperTextBurnJobData
): Promise<{ burned: number; skipped: number; flipped: boolean } | { skipped: string }> {
  const { postId, organizationId } = data;

  const post = await prisma.post.findFirst({
    where: { id: postId, organizationId },
    include: { mediaAttachments: { include: { media: true } } },
  });
  if (!post) {
    console.warn(`[super-text] Post ${postId} not found in org ${organizationId} — skipping`);
    return { skipped: "post_not_found" };
  }

  const meta = ((post.metadata as Record<string, any>) ?? {});
  const st = (meta.superText ?? {}) as Record<string, any>;
  if (st.pendingBurn !== true) return { skipped: "not_pending" };

  const byMediaId = (st.byMediaId ?? {}) as Record<string, unknown>;
  const results: Record<string, any> = { ...(st.results ?? {}) };
  let burned = 0;
  let skipped = 0;

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "supertext-"));
  try {
    for (const [mediaId, rawCfg] of Object.entries(byMediaId)) {
      // Retry idempotency: a BullMQ retry never re-burns an entry that already
      // produced a derived Media row (the swap below is not reversible).
      if (results[mediaId]?.status === "done") {
        skipped++;
        continue;
      }

      const parsed = superTextConfigSchema.safeParse(rawCfg);
      if (!parsed.success) throw new Error(`invalid super-text config for media ${mediaId}`);

      const attachment = post.mediaAttachments.find((a) => a.mediaId === mediaId);
      const media = attachment?.media;
      // Config for media that is no longer attached (user removed it after
      // saving) is skipped, not fatal.
      if (!media || !media.fileType.startsWith("video/")) {
        skipped++;
        continue;
      }
      if (Number(media.fileSize) > MAX_SOURCE_BYTES) {
        throw new Error(`source ${mediaId} exceeds the 950MB super-text cap`);
      }

      // A probe is a metadata read (range-seeks), safe to do over http — unlike a
      // long encode, which must never read through nginx (PR #144 truncation).
      const src = await probe(media.url);
      const width = src.width && src.width >= 16 ? src.width : 1080;
      const height = src.height && src.height >= 16 ? src.height : 1920;

      const stripPath = path.join(tmpDir, `strip-${mediaId}.png`);
      const inputPath = path.join(tmpDir, `in-${mediaId}.mp4`);
      const outputPath = path.join(tmpDir, `out-${mediaId}.mp4`);

      await renderStripPng(buildSuperTextFrameHtml(parsed.data, width, height), width, height, stripPath);
      await downloadToFile(media.url, inputPath);
      await execFileAsync(
        "ffmpeg",
        buildSuperTextCompositeArgs({ inputPath, overlayPngPath: stripPath, outputPath }),
        { timeout: BURN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }
      );

      const out = await probe(outputPath);
      if (!durationIntegrityOk(src.durationSec, out.durationSec)) {
        throw new Error(
          `burn output truncated (${out.durationSec ?? "?"}s vs source ${src.durationSec ?? "?"}s)`
        );
      }

      // Config hash in the key: re-burning after an edit writes a NEW object
      // instead of silently serving a stale cached one.
      const hash = crypto
        .createHash("sha1")
        .update(JSON.stringify(parsed.data))
        .digest("hex")
        .slice(0, 8);
      const key = `supertext/${organizationId}/${mediaId}-${hash}.mp4`;
      const size = (await fsp.stat(outputPath)).size;
      await s3.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: createReadStream(outputPath),
          ContentLength: size,
          ContentType: "video/mp4",
        })
      );
      const url = `${S3_BASE_URL}/${key}`;

      const derived = await prisma.media.create({
        data: {
          organizationId,
          uploadedById: post.createdById,
          fileName: `supertext-${media.fileName}`,
          fileType: "video/mp4",
          fileSize: size,
          url,
          width: out.width ?? width,
          height: out.height ?? height,
          duration: out.durationSec ? Math.round(out.durationSec) : media.duration,
          metadata: {
            superText: { sourceMediaId: mediaId, burnedAt: new Date().toISOString() },
            // Hand the derived file to the STANDARD optimize pipeline exactly like
            // a fresh upload, so IG still gets its 1080×1920 rendition.
            optimize: { status: "pending", enqueuedAt: new Date().toISOString() },
          } as any,
        },
      });

      await mediaOptimizeQueue
        .add(
          "optimize",
          { mediaId: derived.id },
          {
            jobId: `optimize:${derived.id}:v1`,
            attempts: 2,
            backoff: { type: "exponential", delay: 60_000 },
            removeOnComplete: { age: 3600 },
            removeOnFail: { age: 24 * 3600 },
          }
        )
        .catch((e) => console.warn("[super-text] optimize enqueue failed:", e?.message ?? e));

      // Repoint the post at the burned video. The join row keeps its `order`, so
      // carousel/slide ordering is untouched — only which Media it points at.
      await prisma.postMedia.updateMany({
        where: { postId, mediaId },
        data: { mediaId: derived.id },
      });

      results[mediaId] = { status: "done", derivedMediaId: derived.id };
      // Persist per entry so a crash mid-loop never re-burns finished work.
      await stampSuperText(postId, { results });
      burned++;

      await fsp.rm(stripPath, { force: true }).catch(() => undefined);
      await fsp.rm(inputPath, { force: true }).catch(() => undefined);
      await fsp.rm(outputPath, { force: true }).catch(() => undefined);
    }

    await stampSuperText(postId, {
      pendingBurn: false,
      completedAt: new Date().toISOString(),
      results,
    });

    // Flip only if every gate (e.g. a concurrent caption-fanout) is clear.
    const flipped = await flipParkedPostIfReady(prisma as any, postId, organizationId);
    console.log(
      `[super-text] Post ${postId}: burned=${burned} skipped=${skipped} flipped=${flipped}`
    );
    return { burned, skipped, flipped };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function createSuperTextWorker() {
  const worker = new Worker<SuperTextBurnJobData>(
    QUEUE_NAMES.SUPER_TEXT,
    async (job: Job<SuperTextBurnJobData>) => runSuperTextBurn(job.data),
    { connection: createRedisConnection(), concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    console.error(`[super-text] job ${job?.id} failed:`, err?.message ?? err);
    // attemptsMade is incremented before "failed" fires, so >= attempts means
    // there are no retries left → surface it instead of leaving a stuck DRAFT.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void markSuperTextFailed(
        job.data.postId,
        job.data.organizationId,
        err?.message ?? "unknown error"
      ).catch((e) => console.error("[super-text] markSuperTextFailed errored:", e));
    }
  });

  return worker;
}
