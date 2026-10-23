/**
 * Pick-a-frame cover helpers (2026-10-23).
 *
 * The user scrubs through their OWN uploaded video and chooses the frame that
 * becomes the cover. The frame is drawn to a canvas in the browser and handed to
 * the existing cover path (prepareThumbnail → upload → videoThumbnail), so the
 * publish side is unchanged: Instagram Reels get it as cover_url, Facebook and
 * YouTube as their uploaded thumbnail.
 *
 * Canvas reads require the video to be same-origin or CORS-enabled. In
 * production media is served from the app's own origin (/media/), and local
 * MinIO answers CORS, so the dialog sets crossOrigin="anonymous". A tainted
 * canvas throws a SecurityError, which captureVideoFrame turns into a plain
 * message so the user can fall back to uploading an image.
 */

/** Smallest step the fine-adjust buttons move (≈ one frame at 25fps). */
export const FRAME_STEP_SEC = 0.04;

/** Keep a seek target inside the playable range. */
export function clampSeekTime(t: number, durationSec: number): number {
  if (!Number.isFinite(t) || t < 0) return 0;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  // Seeking to the exact end yields no frame on some browsers.
  const lastFrame = Math.max(0, durationSec - FRAME_STEP_SEC);
  return Math.min(t, lastFrame);
}

/** "1:05.40" — minutes:seconds with hundredths, for the scrubber label. */
export function formatTimecode(t: number): string {
  const safe = Number.isFinite(t) && t > 0 ? t : 0;
  const minutes = Math.floor(safe / 60);
  const seconds = safe - minutes * 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, "0")}`;
}

/** File name for a captured frame, e.g. "cover-frame-12.48s.jpg". */
export function frameFileName(t: number): string {
  const safe = Number.isFinite(t) && t > 0 ? t : 0;
  return `cover-frame-${safe.toFixed(2)}s.jpg`;
}

export type FrameCaptureResult = { ok: true; file: File } | { ok: false; reason: string };

/**
 * Draw the video's CURRENT frame at its full display size and return it as a
 * JPEG File. Call only after the video has finished seeking.
 */
export async function captureVideoFrame(
  video: HTMLVideoElement,
  quality = 0.92
): Promise<FrameCaptureResult> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height || video.readyState < 2) {
    return { ok: false, reason: "The video hasn't loaded that frame yet. Wait a moment and try again." };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, reason: "Your browser couldn't capture the frame." };
  try {
    ctx.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) return { ok: false, reason: "Your browser couldn't capture the frame." };
    return { ok: true, file: new File([blob], frameFileName(video.currentTime), { type: "image/jpeg" }) };
  } catch (err) {
    if ((err as { name?: string } | null)?.name === "SecurityError") {
      return {
        ok: false,
        reason: "This video can't be captured in the browser. Upload an image for the cover instead.",
      };
    }
    return { ok: false, reason: "Your browser couldn't capture the frame." };
  } finally {
    // Release the backing store right away; a 4K frame is ~33MB of pixels.
    canvas.width = 0;
    canvas.height = 0;
  }
}
