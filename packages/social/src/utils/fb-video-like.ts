/**
 * "Could this Facebook post carry a view count?" — the gate for the expensive
 * video-view recovery path (resolve → video_insights → reel scrape).
 *
 * ⚠️ Deliberately NOT `mediaType === "video"`. `ExternalPost.mediaType` holds a
 * union of TWO Meta vocabularies: `attachments.media_type` (photo/video/album/
 * share) when the attachment is present, and `status_type` as the fallback
 * (`added_video`, `added_photos`, `mobile_status_update`, …) when it is not —
 * see the fallback in FacebookProvider.listRecentPosts. A live probe on
 * 2026-08-08 returned `status_type: "added_video"` for reels whose
 * `media_type` was `video`, so both vocabularies really do reach this column.
 * Prod also holds 16 rows labelled `mobile_status_update`.
 *
 * ⚠️ UNKNOWN ⇒ TRUE. The asymmetry is deliberate: a wasted attempt costs one
 * cheap lookup on data we already hold, while a wrongly-skipped post is a
 * PERMANENT "—" for that row. So this returns false only for labels we KNOW
 * cannot carry a view count.
 *
 * Pure + total. Tested in fb-video-like.test.ts against every value present in
 * prod plus the status_type vocabulary.
 */

/** Labels that definitely denote video. */
const VIDEO_LIKE = new Set([
  "video",
  "video_inline",
  "video_autoplay",
  "added_video",
  "video_direct_response",
  // IG stores these uppercase; we lowercase before lookup.
  "reels",
]);

/** Labels that definitely CANNOT carry a view count. */
const NOT_VIDEO = new Set([
  "photo",
  "added_photos",
  "album",
  "link",
  "shared_story",
  "note",
  "status",
  "mobile_status_update",
  "profile_media",
  "cover_photo",
]);

export function isFacebookVideoLike(input: {
  mediaType?: string | null;
  permalink?: string | null;
  videoId?: string | null;
}): boolean {
  // Listing already resolved a Video/Reel node — definitive.
  if (input.videoId) return true;

  const t = String(input.mediaType ?? "").trim().toLowerCase();
  if (VIDEO_LIKE.has(t)) return true;

  // A /reel/, /videos/ or /watch permalink is video regardless of the label.
  if (/\/reel\/|\/videos\/|\/watch/i.test(String(input.permalink ?? ""))) return true;

  if (NOT_VIDEO.has(t)) return false;

  // Empty label + no other signal ⇒ nothing suggests video; don't spend the call.
  // Any OTHER non-empty label is an unrecognized vocabulary entry ⇒ attempt it.
  return t !== "";
}
