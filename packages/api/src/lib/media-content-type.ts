import { TRPCError } from "@trpc/server";

/**
 * What a stored media object is allowed to be served as (security audit
 * 2026-09-28).
 *
 * /media/ is served from the APP'S OWN ORIGIN (postautomation.co.in), so an
 * object stored as text/html or image/svg+xml renders as a page there and can
 * run script with a visitor's session. nginx now sandboxes that path, but the
 * stored type must be right in the first place: derived from the bytes where we
 * can, and never something a browser treats as a document.
 */

export type SniffedImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** Identify an image by its magic bytes. `null` for anything we do not store as an image. */
export function sniffImageMime(buf: Buffer): SniffedImageMime | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG" && buf[4] === 0x0d && buf[5] === 0x0a) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6) {
    const sig = buf.toString("latin1", 0, 6);
    if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
  }
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

export const IMAGE_EXTENSIONS: Record<SniffedImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * The content types any code path may store in the public bucket. An
 * ALLOWLIST: SVG, HTML, XML, JavaScript and PDF are all rendered or executed by
 * a browser opened on the URL, so none of them belongs in a same-origin bucket.
 */
const SAFE_STORED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v",
]);

export function assertSafeStoredContentType(contentType: string): void {
  const base = contentType.split(";")[0]!.trim().toLowerCase();
  if (!SAFE_STORED_TYPES.has(base)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Files of type "${base || "unknown"}" can't be stored. Use a PNG, JPEG, WebP or GIF image, or an MP4/MOV/WebM video.`,
    });
  }
}
