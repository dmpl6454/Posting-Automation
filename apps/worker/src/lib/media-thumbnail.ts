/**
 * Small WebP thumbnails for the Media grid (2026-11-10).
 *
 * The grid used to load every ORIGINAL — a phone photo is 3–8 MB — and drew a
 * `<video preload="metadata">` per video tile. One 512×512 WebP (~20–60 KB)
 * per Media row replaces both. Videos get a still frame, so the grid draws an
 * `<img>` for them too; the lightbox still plays the real file.
 *
 * Decisions, the sharp encode and the ffmpeg frame grab live here; the
 * download and S3 upload live in media-process.worker.
 */
import sharp from "sharp";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { buildFrameGrabArgs } from "./super-text-cover";

const execFileAsync = promisify(execFile);

/** Edge length of the square thumbnail. Grid cells are ≤ ~250 CSS px, so 512 is sharp at 2× DPR. */
export const THUMB_EDGE = 512;
export const THUMB_QUALITY = 72;
/** Bump when the encode changes; part of the S3 key so a new version never reuses an old object. */
export const THUMB_VERSION = 1;
/** Images larger than this are not downloaded into worker memory for a thumbnail. */
export const THUMB_MAX_IMAGE_BYTES = 60 * 1024 * 1024;

export type ThumbnailPlan =
  | { kind: "image" }
  | { kind: "video" }
  | { kind: "skip"; reason: string };

export function planThumbnail(media: {
  fileType: string;
  fileSize: bigint | number;
  url: string;
}): ThumbnailPlan {
  const type = (media.fileType || "").toLowerCase();
  if (!/^https?:\/\//i.test(media.url)) return { kind: "skip", reason: "no http url" };
  if (type.startsWith("video/")) return { kind: "video" };
  if (!type.startsWith("image/")) return { kind: "skip", reason: "not an image or video" };
  // SVG is already small and vector; rasterising user SVG buys nothing.
  if (type.includes("svg")) return { kind: "skip", reason: "svg" };
  if (Number(media.fileSize) > THUMB_MAX_IMAGE_BYTES) return { kind: "skip", reason: "image too large" };
  return { kind: "image" };
}

export function thumbnailKey(organizationId: string, mediaId: string): string {
  return `orgs/${organizationId}/media/${mediaId}/thumb_${THUMB_EDGE}_v${THUMB_VERSION}.webp`;
}

/** True when the stored thumbnail is already the current WebP version. */
export function hasCurrentThumbnail(thumbnailUrl: string | null | undefined): boolean {
  return !!thumbnailUrl && thumbnailUrl.endsWith(`thumb_${THUMB_EDGE}_v${THUMB_VERSION}.webp`);
}

/**
 * Square WebP thumbnail. `.rotate()` applies EXIF orientation (phone photos
 * otherwise come out sideways); only the first frame of an animated GIF/WebP
 * is used; never upscales a tiny image.
 */
export async function renderThumbnailWebp(input: Buffer): Promise<Buffer> {
  return sharp(input, { animated: false, limitInputPixels: 120_000_000 })
    .rotate()
    .resize(THUMB_EDGE, THUMB_EDGE, { fit: "cover", position: "centre", withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY, effort: 4 })
    .toBuffer();
}

/** Timestamps tried for a video still, in order (a short clip may not reach 1s). */
export const VIDEO_THUMB_TIMES = [1.0, 0.2];

/**
 * One still frame from a video, as PNG bytes. Input seek (`-ss` before `-i`)
 * reads only the start of the file, even over http. Runs under `nice` so it
 * yields to publish work on the 4-core box. Tries 1s, then 0.2s (short clips).
 */
export async function grabVideoFrame(url: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "thumb-"));
  try {
    let lastErr: unknown;
    for (const t of VIDEO_THUMB_TIMES) {
      const out = path.join(dir, `f-${t}.png`);
      try {
        await execFileAsync("nice", ["-n", "10", "ffmpeg", "-loglevel", "error", ...buildFrameGrabArgs(url, out, t)], {
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        const png = await readFile(out);
        if (png.length > 0) return png;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`Could not read a frame from the video: ${(lastErr as Error)?.message ?? "no frame"}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
