/**
 * Render a 9:16 story frame from a source image (2026-09-16).
 *
 * The content is CONTAINED (never cropped) on a 1080x1920 canvas whose padding
 * carries a blurred, darkened copy of the same image — what the Instagram app
 * itself produces when you post a non-9:16 photo by hand. See story-fit.ts for
 * why this exists at all.
 *
 * Video goes through ffmpeg instead (story-render-args.ts); the geometry comes
 * from the SAME plan so the two paths lay out identically.
 */

import sharp from "sharp";
import type { StoryFitPlan, Dimensions } from "./story-fit";

/** Instagram's story image cap is 8MB; JPEG quality steps down to fit under it. */
export const STORY_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const STORY_JPEG_QUALITY_LADDER = [90, 82, 74, 66] as const;

export interface ImageProbe extends Dimensions {
  /** sharp's format name: "jpeg", "png", "webp", … */
  format: string | null;
}

/**
 * Read a source image's display dimensions and format in ONE parse.
 *
 * ⚠️ EXIF orientation 5-8 swaps the axes, and sharp reports PRE-rotation
 * numbers, so a portrait phone photo would otherwise be planned as landscape.
 */
export async function probeImageSource(input: Buffer): Promise<ImageProbe | null> {
  try {
    const meta = await sharp(input).metadata();
    const swap = (meta.orientation ?? 1) >= 5;
    const width = swap ? meta.height : meta.width;
    const height = swap ? meta.width : meta.height;
    if (!width || !height) return null;
    return { width, height, format: meta.format ?? null };
  } catch {
    return null;
  }
}

/** Dimensions only — kept for callers and tests that do not need the format. */
export async function probeImageSize(input: Buffer): Promise<Dimensions | null> {
  const probe = await probeImageSource(input);
  return probe ? { width: probe.width, height: probe.height } : null;
}

/**
 * Compose the story frame. Returns JPEG bytes under the platform cap.
 *
 * ⚠️ `.rotate()` with no argument applies EXIF orientation and then drops the
 * tag. Without it a phone photo renders sideways inside the canvas — and unlike
 * a feed post, nothing downstream would correct it.
 */
export async function renderStoryImage(input: Buffer, plan: StoryFitPlan): Promise<Buffer> {
  const { canvas, inner } = plan;

  const backdrop = await sharp(input)
    .rotate()
    .resize(canvas.width, canvas.height, { fit: "cover", position: "centre" })
    .blur(40)
    .modulate({ brightness: 0.88 })
    .toBuffer();

  const foreground = await sharp(input)
    .rotate()
    .resize(inner.width, inner.height, { fit: "fill" })
    .toBuffer();

  const composite = sharp(backdrop).composite([{ input: foreground, left: inner.left, top: inner.top }]);

  let out = await composite.jpeg({ quality: STORY_JPEG_QUALITY_LADDER[0], mozjpeg: true }).toBuffer();
  for (const quality of STORY_JPEG_QUALITY_LADDER.slice(1)) {
    if (out.byteLength <= STORY_IMAGE_MAX_BYTES) break;
    out = await sharp(backdrop)
      .composite([{ input: foreground, left: inner.left, top: inner.top }])
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  }
  return out;
}
