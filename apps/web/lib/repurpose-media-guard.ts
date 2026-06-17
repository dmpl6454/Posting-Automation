/**
 * R4 defense-in-depth guard for the Repurpose "Create Drafts" button.
 *
 * Backstops the backend fix (a failed static-image render now THROWS a hard
 * error). If a media-less result ever reaches the UI for an IMAGE post, this
 * prevents creating a draft that would fail to publish to Instagram/Facebook
 * ("requires an attached image; none attached").
 */

/**
 * Repurpose VIDEO formats. These deliver their media asynchronously (the worker
 * posts the stitched/generated video via the progress SSE), so an empty
 * `mediaIds` at draft time is EXPECTED (videoPending) and must NOT be blocked.
 *
 * Note: `results.format` is the BACKEND format — the UI-only "postcard" maps to
 * "static" before reaching the backend, so it is correctly treated as an image
 * format here (not present in this video set).
 */
export const REPURPOSE_VIDEO_FORMATS = new Set(["ai_video", "seedance_video", "reel"]);

/**
 * Platforms that REQUIRE an attached image/media to publish. A media-less draft
 * targeting any of these will fail at publish time.
 */
export const MEDIA_REQUIRED_PLATFORMS = new Set(["INSTAGRAM", "FACEBOOK"]);

/**
 * Whether to block creating a media-less draft.
 *
 * Returns true iff ALL hold:
 *   - `mediaIds` is empty, AND
 *   - `format` is an IMAGE format (NOT one of REPURPOSE_VIDEO_FORMATS), AND
 *   - at least one `selectedPlatforms` entry is a media-required platform.
 *
 * Pure + total — `selectedPlatforms` entries may be undefined (an unresolved
 * channel id); those are ignored.
 */
export function shouldBlockMediaLessPublish(
  mediaIds: readonly string[],
  format: string,
  selectedPlatforms: readonly (string | undefined | null)[],
): boolean {
  if (mediaIds.length > 0) return false;
  if (REPURPOSE_VIDEO_FORMATS.has(format)) return false;
  return selectedPlatforms.some(
    (p) => !!p && MEDIA_REQUIRED_PLATFORMS.has(p.toUpperCase()),
  );
}
