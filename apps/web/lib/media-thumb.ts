import { VIDEO_EXT_RE } from "../components/previews/preview-media";

/**
 * The small WebP the worker made for a Media row (2026-11-10), or null.
 *
 * Only ever an http(s) IMAGE url: never a video file (WebKit loads a whole
 * video into memory when an <img> gets one — see preview-media.tsx). Callers
 * fall back to the original when this returns null.
 */
export function mediaThumbSrc(media: { thumbnailUrl?: string | null }): string | null {
  const t = media.thumbnailUrl;
  if (!t || !/^https?:\/\//i.test(t)) return null;
  if (VIDEO_EXT_RE.test(t)) return null;
  return t;
}
