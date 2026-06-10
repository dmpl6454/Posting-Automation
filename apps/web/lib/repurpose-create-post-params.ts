/**
 * Pure helpers for building / parsing the "Create Post" deep-link query that the
 * Repurpose tab uses to hand a generated creative to the Compose editor.
 *
 * Carousel is the critical case: a carousel must forward ALL its slide media ids
 * (so Compose attaches every slide and the IG carousel path triggers), whereas a
 * static or reel post forwards a single media id. Keeping the param logic in a
 * pure function makes the carousel-vs-single behaviour unit-testable without
 * mounting React.
 */

export interface BuildCreatePostQueryArgs {
  /** The post format from the repurpose result. */
  format?: string;
  /** The caption / content text to seed Compose with. */
  content: string;
  /** Preview image URL (single static/reel image). */
  image?: string;
  /** Single media id (static/reel). */
  mediaId?: string;
  /** All carousel slide media ids (in order). Used only when format === "carousel". */
  carouselMediaIds?: string[];
  /** All carousel slide image URLs (same order as carouselMediaIds) — for previews. */
  carouselImages?: string[];
}

/** Video formats whose single rendered media id lives only in carouselMediaIds[0]. */
const VIDEO_FORMATS = new Set(["reel", "seedance_video", "ai_video"]);

/**
 * Build the query string (WITHOUT the leading "?") for the Compose deep link.
 *
 * - carousel + carouselMediaIds present → emits `&aiMediaIds=a,b,c` (ALL slides),
 *   and NO single `&aiMediaId=`.
 * - video formats (reel / seedance_video / ai_video): the async worker returns the
 *   stitched video's media id in `carouselMediaIds[0]` (NOT `mediaId`). Forward it
 *   as the SINGLE `aiMediaId` (and `aiImage`=video url) so Compose attaches the
 *   video — without this the per-platform Create Post opened with no media.
 * - otherwise → emits the single `&aiMediaId=` (and `&aiImage=` when an image URL
 *   is present), preserving the legacy static/reel behaviour.
 */
export function buildCreatePostQuery(args: BuildCreatePostQueryArgs): string {
  const { format, content, image, mediaId, carouselMediaIds, carouselImages } = args;

  const params: string[] = [];
  params.push(`tab=compose`);
  params.push(`content=${encodeURIComponent(content)}`);

  const isCarousel = format === "carousel" && Array.isArray(carouselMediaIds) && carouselMediaIds.length > 0;

  // Video result: the single video media id is in carouselMediaIds[0]. Forward it
  // as ONE aiMediaId (NOT aiMediaIds — a video is one piece of media).
  const videoMediaId =
    format && VIDEO_FORMATS.has(format) && Array.isArray(carouselMediaIds) && carouselMediaIds.length > 0
      ? carouselMediaIds[0]
      : undefined;

  if (isCarousel) {
    // Forward ALL slides so Compose attaches every one (carousel publish fix).
    params.push(`aiMediaIds=${encodeURIComponent(carouselMediaIds!.join(","))}`);
    if (Array.isArray(carouselImages) && carouselImages.length > 0) {
      // Parallel URL list so Compose can render slide previews.
      params.push(`aiImages=${encodeURIComponent(carouselImages.join(","))}`);
    }
  } else if (videoMediaId) {
    if (image) {
      params.push(`aiImage=${encodeURIComponent(image)}`);
    }
    // Single media id for the stitched video (worker put it in carouselMediaIds[0]).
    params.push(`aiMediaId=${encodeURIComponent(videoMediaId)}`);
  } else {
    if (image) {
      params.push(`aiImage=${encodeURIComponent(image)}`);
    }
    if (mediaId) {
      // Static / reel: single media id.
      params.push(`aiMediaId=${encodeURIComponent(mediaId)}`);
    }
  }

  return params.join("&");
}

/**
 * Parse the media ids the Compose editor should pre-attach, from the deep-link
 * search params. Prefers the multi-id list (`aiMediaIds`, comma-separated) and
 * falls back to the single `aiMediaId`. Returns [] when neither is present.
 */
export function parseCreatePostMediaIds(args: {
  aiMediaIds?: string | null;
  aiMediaId?: string | null;
}): string[] {
  const { aiMediaIds, aiMediaId } = args;
  const list = parseCsvList(aiMediaIds);
  if (list.length > 0) return list;
  if (aiMediaId && aiMediaId.trim().length > 0) {
    return [aiMediaId.trim()];
  }
  return [];
}

/** Split a comma-separated query value into a trimmed, empty-filtered list. */
export function parseCsvList(value?: string | null): string[] {
  if (!value || value.trim().length === 0) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
