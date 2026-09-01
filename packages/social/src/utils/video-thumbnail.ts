/**
 * User-uploaded custom thumbnail (cover image) for a published video/reel.
 *
 * ── Where it comes from ──────────────────────────────────────────────────────
 * The user picks or uploads an image on the Compose video tile. `post.create`
 * validates that the image Media row belongs to the org, resolves its PUBLIC S3
 * URL server-side (never trusting a client-supplied url), and writes
 * `Post.metadata.videoThumbnail = { mediaId, url }`. The publish worker already
 * merges `Post.metadata` into `payload.metadata`, so it reaches every provider
 * with no schema change.
 *
 * ── Why a shared resolver instead of reading the key inline ──────────────────
 * Three providers consume it (IG cover_url, FB /{video}/thumbnails, YouTube
 * thumbnails.set) and each sends it a DIFFERENT way. The one thing they must
 * agree on is what counts as a usable thumbnail — a half-validated URL reaching
 * Meta is not a cosmetic bug: Instagram cURLs `cover_url` server-side and a bad
 * one puts the media container into ERROR, failing the ENTIRE reel publish, not
 * just the cover.
 *
 * ⚠️ `videoThumbnail` is deliberately NOT keyed by mediaId. The super-text and
 * media-optimize workers create DERIVED Media rows and repoint `PostMedia` to
 * them, so at publish time the attachment's media id is no longer the id the
 * user picked against — a mediaId-keyed lookup would silently miss. One cover
 * per post sidesteps that entirely, and matches the platforms: a reel, a
 * Facebook video and a YouTube upload each have exactly one cover.
 *
 * ⚠️ Absent metadata must leave every provider call byte-identical. The IG/FB
 * publish paths are contractually frozen ("the posting process works — do NOT
 * break it"), so every caller gates on this returning null.
 */

/** The shape written by post.create into Post.metadata.videoThumbnail. */
export interface VideoThumbnailRef {
  mediaId: string;
  url: string;
}

/**
 * Same discipline as `safeImageUrl` in the creative templates: an allowlist, not
 * a denylist. The URL is handed to Meta/Google to fetch, and is interpolated into
 * request bodies, so anything with whitespace, quotes or angle brackets is
 * rejected outright rather than escaped.
 */
function isSafeHttpUrl(raw: string): boolean {
  if (!/^https?:\/\//i.test(raw)) return false;
  if (/["'<>\\\s]/.test(raw)) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Extract a usable custom-thumbnail URL from a provider payload's metadata.
 *
 * Returns null — meaning "behave exactly as before" — when the key is absent,
 * malformed, or carries a URL we would not hand to a platform.
 */
export function resolveVideoThumbnailUrl(
  metadata: Record<string, unknown> | undefined | null
): string | null {
  const raw = metadata?.videoThumbnail;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const url = (raw as Record<string, unknown>).url;
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed || !isSafeHttpUrl(trimmed)) return null;
  return trimmed;
}

/**
 * Instagram accepts a cover ONLY on a REELS container.
 *
 * ⚠️ Sending `cover_url` on a STORIES container (or an image container) 400s the
 * container creation, which fails the whole publish. Meta's docs are explicit
 * that cover_url is reels-only; carousel VIDEO children accept `thumb_offset`
 * but not `cover_url`. So the gate is on the resolved media_type, never on
 * "is this a video".
 */
export function supportsInstagramCover(mediaType: string): boolean {
  return mediaType === "REELS";
}
