/**
 * Client-side preparation for a custom video cover ("smart" thumbnails).
 *
 * Why this exists: the first release REFUSED any image over 2MB (YouTube's API
 * cap — the tightest of the three platforms) and anything that wasn't already
 * JPEG/PNG surfaced an opaque server error. Phone photos are routinely 3–8MB
 * HEIC/large JPEG, so the refusal fired constantly (owner-reported 2026-09-02).
 * Instead of refusing, fit the image HERE: decode → optional center-crop to the
 * video's own aspect → downscale → JPEG quality ladder until it's under the cap.
 * All client-side (canvas), so bulk use adds zero server load — the server only
 * ever receives a ≤2MB JPEG/PNG.
 *
 * Crop rationale: a cover is a stand-in FRAME of the video. Instagram fits
 * `cover_url` to the reel's frame server-side anyway; matching the video's
 * aspect ourselves makes every platform (and our own preview) consistent and
 * predictable. When the video's aspect is unknown, we only resize — never guess.
 *
 * The geometry/decision functions are PURE and unit-tested; only
 * `prepareThumbnail` touches the DOM (canvas/createImageBitmap), which has no
 * vitest harness here — keep all branching in the pure parts.
 */

export const THUMB_MAX_BYTES = 2 * 1024 * 1024; // YouTube API cap; IG/FB accept more, one cover serves all
export const THUMB_MAX_EDGE = 1920; // IG reel cover ceiling (1080×1920); more pixels buy nothing
// Aspect within 2% of the video's counts as matching — re-encoding for a
// rounding-level difference would only cost quality.
const ASPECT_TOLERANCE = 0.02;
// JPEG quality ladder tried at full planned size, then again after halving.
export const JPEG_QUALITY_LADDER = [0.92, 0.85, 0.75, 0.65, 0.55] as const;
// Below this long edge we give up rather than ship an unusably small cover.
// A 640px q0.55 JPEG is far under 2MB in practice, so this is unreachable for
// any real photograph — it guards against pathological synthetic images.
const MIN_OUT_EDGE = 640;

export interface ThumbTransform {
  /** Source crop rect (center-crop to the video's aspect; whole image when null). */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Canvas output size after downscaling to THUMB_MAX_EDGE (never upscaled). */
  outW: number;
  outH: number;
  cropped: boolean;
  scaled: boolean;
}

/** Pure geometry: what crop + scale would we apply to a srcW×srcH image? */
export function planThumbnailTransform(
  srcW: number,
  srcH: number,
  videoAspect: number | null
): ThumbTransform {
  let sx = 0;
  let sy = 0;
  let sw = srcW;
  let sh = srcH;
  let cropped = false;
  if (videoAspect && videoAspect > 0 && srcW > 0 && srcH > 0) {
    const srcAspect = srcW / srcH;
    if (Math.abs(srcAspect - videoAspect) / videoAspect > ASPECT_TOLERANCE) {
      if (srcAspect > videoAspect) {
        // Image is wider than the video: crop the sides.
        sw = Math.max(1, Math.round(srcH * videoAspect));
        sx = Math.round((srcW - sw) / 2);
      } else {
        // Image is taller than the video: crop top/bottom.
        sh = Math.max(1, Math.round(srcW / videoAspect));
        sy = Math.round((srcH - sh) / 2);
      }
      cropped = true;
    }
  }
  const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(sw, sh, 1)); // never upscale
  const outW = Math.max(1, Math.round(sw * scale));
  const outH = Math.max(1, Math.round(sh * scale));
  return { sx, sy, sw, sh, outW, outH, cropped, scaled: scale < 1 };
}

/**
 * Pure decision: can the original file be uploaded byte-identical?
 * True ⇒ re-encode. Platforms accept JPEG/PNG only, so any other decodable
 * format (webp, HEIC on Safari, avif, gif) is normalized to JPEG here rather
 * than bounced by the platform at publish time.
 */
export function needsReencode(fileType: string, fileSize: number, t: ThumbTransform): boolean {
  const typeOk = fileType === "image/jpeg" || fileType === "image/png";
  return !typeOk || fileSize > THUMB_MAX_BYTES || t.cropped || t.scaled;
}

/** Pure: the human-readable note for the success toast ("what did we do to your image"). */
export function describeThumbAdjustment(
  t: ThumbTransform,
  converted: boolean,
  finalBytes: number
): string | null {
  const parts: string[] = [];
  if (t.cropped) parts.push("cropped to the video's aspect");
  if (t.scaled) parts.push(`resized to ${t.outW}×${t.outH}`);
  if (converted && !t.cropped && !t.scaled) parts.push("converted to JPEG");
  if (parts.length === 0 && finalBytes <= THUMB_MAX_BYTES) return null;
  const mb = (finalBytes / 1024 / 1024).toFixed(1);
  return `Adjusted (${parts.join(", ") || "compressed"}, ${mb}MB) to fit platform limits.`;
}

export type PreparedThumbnail =
  | { ok: true; file: File; note: string | null }
  | { ok: false; reason: string };

const canvasToBlob = (canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));

async function decodeImage(
  file: File
): Promise<{ src: CanvasImageSource; width: number; height: number; release: () => void } | null> {
  // createImageBitmap decodes everything the browser can (incl. HEIC on Safari)
  // and defaults to honoring EXIF orientation in current engines.
  try {
    const bmp = await createImageBitmap(file);
    return { src: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
  } catch {
    /* fall through to <img> */
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () =>
      resolve({
        src: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        release: () => URL.revokeObjectURL(url),
      });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * Fit `file` to the cover constraints. Returns the ORIGINAL file untouched when
 * it already fits (JPEG/PNG, ≤2MB, aspect/size fine) so the pre-existing happy
 * path stays byte-identical; otherwise a freshly encoded JPEG.
 */
export async function prepareThumbnail(
  file: File,
  videoAspect: number | null
): Promise<PreparedThumbnail> {
  const decoded = await decodeImage(file);
  if (!decoded || decoded.width < 1 || decoded.height < 1) {
    return {
      ok: false,
      reason:
        "That image couldn't be read by this browser. Convert it to JPEG or PNG and try again.",
    };
  }
  try {
    const plan = planThumbnailTransform(decoded.width, decoded.height, videoAspect);
    if (!needsReencode(file.type, file.size, plan)) {
      return { ok: true, file, note: null };
    }
    let { outW, outH } = plan;
    // Full planned size first, halving until the ladder lands under the cap.
    while (Math.max(outW, outH) >= MIN_OUT_EDGE) {
      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { ok: false, reason: "This browser blocked image processing (canvas unavailable)." };
      // JPEG has no alpha — flatten transparency to white, not black.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, outW, outH);
      ctx.drawImage(decoded.src, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, outW, outH);
      for (const q of JPEG_QUALITY_LADDER) {
        const blob = await canvasToBlob(canvas, q);
        if (blob && blob.size <= THUMB_MAX_BYTES) {
          const out = new File([blob], "cover.jpg", { type: "image/jpeg" });
          return {
            ok: true,
            file: out,
            note: describeThumbAdjustment(
              { ...plan, outW, outH },
              file.type !== "image/jpeg",
              blob.size
            ),
          };
        }
      }
      outW = Math.max(1, Math.round(outW / 2));
      outH = Math.max(1, Math.round(outH / 2));
    }
    return {
      ok: false,
      reason: "That image couldn't be compressed under 2MB. Try a simpler image.",
    };
  } finally {
    decoded.release();
  }
}