import sharp from "sharp";

/**
 * Cover-scope super text (2026-10-02, owner decision): the strip is composited
 * onto the video's COVER image instead of being burned into every frame.
 *
 * The cover then rides the existing `videoThumbnail` path untouched — Instagram
 * `cover_url` on the REELS container, Facebook `POST /{video}/thumbnails`,
 * YouTube `thumbnails.set` — so the provider code does not change at all. The
 * video file is never re-encoded: one frame grab (or the user's own cover) plus
 * one PNG composite per variant, which is what makes a 200-channel fan-out of
 * different lines affordable.
 *
 * Pure image work only — the ffmpeg frame grab and S3 upload live in the worker.
 */

/** Instagram rejects covers over 8MB; a 1080-wide JPEG at q90 is ~300–600KB. */
export const COVER_MAX_BYTES = 8 * 1024 * 1024;
/** Long-edge cap so a 4K frame does not produce a multi-MB cover for a 1080 reel. */
export const COVER_MAX_EDGE = 1920;
export const COVER_JPEG_QUALITY_LADDER = [90, 82, 74, 66] as const;

export interface CoverBase {
  /** Display-oriented pixels (EXIF applied), resized under COVER_MAX_EDGE. */
  png: Buffer;
  width: number;
  height: number;
}

/**
 * Normalise the base image (a grabbed frame or the user's uploaded cover): apply
 * EXIF orientation, cap the long edge, and hand back PNG + its FINAL size — the
 * size the strip must be rendered at, or the two will not line up.
 *
 * ⚠️ `.rotate()` is mandatory: sharp reports PRE-rotation dimensions for a
 * phone photo, and the strip would be laid out for a landscape frame.
 */
export async function prepareCoverBase(input: Buffer): Promise<CoverBase> {
  // Through raw() so the base is 8-bit RGB whatever the input depth (16-bit
  // PNG frames, HEIC covers): the strip PNG is 8-bit and the JPEG will be.
  const { data, info } = await sharp(input)
    .rotate()
    .resize(COVER_MAX_EDGE, COVER_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (!info.width || !info.height) throw new Error("cover base has no dimensions");
  const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png()
    .toBuffer();
  return { png, width: info.width, height: info.height };
}

/**
 * Composite the transparent strip PNG (rendered at exactly base.width × base.height)
 * over the base and encode a JPEG under the platform cap.
 */
export async function composeCoverJpeg(base: CoverBase, stripPng: Buffer): Promise<Buffer> {
  const stripMeta = await sharp(stripPng).metadata();
  if (stripMeta.width !== base.width || stripMeta.height !== base.height) {
    throw new Error(
      `strip ${stripMeta.width}x${stripMeta.height} does not match cover ${base.width}x${base.height}`
    );
  }
  for (const quality of COVER_JPEG_QUALITY_LADDER) {
    const out = await sharp(base.png)
      .composite([{ input: stripPng, left: 0, top: 0 }])
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (out.length <= COVER_MAX_BYTES) return out;
  }
  throw new Error("cover exceeds the 8MB platform cap at every quality step");
}

/**
 * Which image the cover starts from. A cover the user uploaded in Compose wins
 * — they chose that frame — and the strip is laid over it; otherwise the video's
 * first frame. Pure: the worker fetches whichever this names.
 */
export function planCoverBase(postMetadata: unknown): { kind: "user-cover"; url: string } | { kind: "first-frame" } {
  const raw = (postMetadata as { videoThumbnail?: { url?: unknown; superText?: unknown } } | null | undefined)
    ?.videoThumbnail;
  // A cover WE generated on an earlier attempt is not the user's — start from
  // the frame again rather than stacking a second strip on the first.
  if (raw && typeof raw.url === "string" && /^https?:\/\//i.test(raw.url) && !raw.superText) {
    return { kind: "user-cover", url: raw.url };
  }
  return { kind: "first-frame" };
}

/**
 * ffmpeg argv for ONE frame near the start of the video, as PNG. `-ss` before
 * `-i` seeks on input (reads only the start, even over http — a short read, not
 * the long encode that PR #144 forbids through nginx); ffmpeg applies the
 * rotation tag on decode so the frame comes out display-oriented.
 */
export function buildFrameGrabArgs(input: string, outPng: string, atSec = 0.2): string[] {
  // -pix_fmt rgb24: an 8-bit frame. Without it ffmpeg emits 16-bit PNG for
  // 10-bit/HDR sources, which skews every stat in scoreCoverCandidate.
  return ["-y", "-ss", String(atSec), "-i", input, "-frames:v", "1", "-f", "image2", "-vcodec", "png", "-pix_fmt", "rgb24", outPng];
}

/* ─── Which frame? ──────────────────────────────────────────────────────────
 * Instagram's own default cover is the first frame, which is often a black
 * fade-in or motion blur. We sample a few EARLY moments (the cover should still
 * look like the start of the clip) and keep the one that is sharp and not
 * blank; the user's uploaded cover always wins over this (planCoverBase).
 */

/** Candidate timestamps (seconds) for an auto-picked cover, earliest first. */
export function coverCandidateTimes(durationSec: number | undefined): number[] {
  const d = durationSec && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : undefined;
  const raw = [0.2, 1.0, 2.0, d ? Math.min(4, d * 0.25) : 3.0];
  const out: number[] = [];
  for (const t of raw) {
    const v = Math.round(t * 10) / 10;
    if (d !== undefined && v > Math.max(0, d - 0.15)) continue;
    if (!out.includes(v)) out.push(v);
  }
  out.sort((a, b) => a - b);
  return out.length ? out : [0];
}

export interface CoverScore {
  /** Laplacian energy — edge detail; ~0 for a flat/black/blurred frame. */
  sharpness: number;
  /** Mean luminance 0–255. */
  brightness: number;
  /** Std-dev of luminance — contrast. */
  contrast: number;
  score: number;
}

/**
 * Score a candidate frame. Sharpness × contrast, heavily penalised when the
 * frame is near-black or blown out (a fade, a flash, a title card wash).
 */
export async function scoreCoverCandidate(png: Buffer): Promise<CoverScore> {
  // ⚠️ Always score on 8-bit samples. ffmpeg writes 16-bit PNG frames for many
  // sources, and sharp's stats() then reports a 0–65535 range — a brightness of
  // ~35,000 for a normal frame, so the near-black/blown-out gates never fired on
  // real input (caught on the owner's reference clip). `raw()` is uchar.
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, n = w * h;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += data[i]!;
  const brightness = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) { const d = data[i]! - brightness; varSum += d * d; }
  const contrast = Math.sqrt(varSum / n);
  // Laplacian energy (4-neighbour kernel), std-dev over interior pixels.
  let lapSum = 0, lapSq = 0, cnt = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      const v = data[i - w]! + data[i + w]! + data[i - 1]! + data[i + 1]! - 4 * data[i]!;
      lapSum += v; lapSq += v * v; cnt++;
    }
  }
  const lapMean = cnt ? lapSum / cnt : 0;
  const sharpness = cnt ? Math.sqrt(Math.max(0, lapSq / cnt - lapMean * lapMean)) : 0;
  let score = sharpness * (1 + contrast / 64);
  if (brightness < 20 || brightness > 235) score *= 0.1;
  return { sharpness, brightness, contrast, score };
}

/**
 * Pick the best candidate. Earlier frames win near-ties (a later frame must beat
 * the current best by >10%), so the cover still reads as the clip's opening.
 */
export function pickBestCover<T extends { score: number }>(candidates: T[]): T | null {
  let best: T | null = null;
  for (const c of candidates) {
    if (!best || c.score > best.score * 1.1) best = c;
  }
  return best;
}
