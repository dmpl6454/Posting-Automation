/**
 * Story canvas geometry (2026-09-16).
 *
 * WHY THIS EXISTS. A story canvas is 9:16. When the media we hand Instagram is
 * some other shape, Instagram does NOT letterbox it: the mobile app scales it to
 * FILL and crops the overflow, while the instagram.com web viewer fits the whole
 * frame. Same story, two different pictures — and on a 4:5 news creative the
 * mobile crop eats the caption text at both ends (owner report 2026-09-16, with
 * screenshots). Posting the same photo by hand in the Instagram app does not do
 * this, because the app composes a 9:16 image first and pads what is left over.
 *
 * So we do what the app does: produce a 1080x1920 rendition with the ENTIRE
 * source contained inside it, and let the padding carry a blurred copy of the
 * image (owner's choice 2026-09-16). Then mobile and web agree, because there is
 * nothing left to crop.
 *
 * ⚠️ PURE geometry only — no sharp, no ffmpeg, no I/O — so it runs in ms under
 * vitest and the arithmetic is test-locked independently of the renderers.
 */

/** The story canvas every platform renders at. */
export const STORY_WIDTH = 1080;
export const STORY_HEIGHT = 1920;
export const STORY_ASPECT = STORY_WIDTH / STORY_HEIGHT; // 0.5625

/**
 * How far from 9:16 the source may sit before we re-render it.
 *
 * ⚠️ Load-bearing: within this tolerance the media is passed through UNTOUCHED,
 * so every already-correct story keeps its byte-identical publish path. 0.5% of
 * the ratio covers rounding (1080x1919, 1079x1920) without letting a visibly
 * different shape through — a 4:5 photo is 47% off, a 1:1 is 78% off.
 */
export const STORY_ASPECT_TOLERANCE = 0.005;

export interface Dimensions {
  width: number;
  height: number;
}

/**
 * Does this source need a story rendition?
 *
 * Returns false for anything already 9:16 (within tolerance) and for unusable
 * dimensions — a zero/NaN/negative probe means we could not measure the file,
 * and re-rendering on a guess is worse than publishing what the user gave us.
 */
export function needsStoryFit(src: Dimensions | null | undefined): boolean {
  if (!src) return false;
  const { width, height } = src;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  const ratio = width / height;
  return Math.abs(ratio - STORY_ASPECT) / STORY_ASPECT > STORY_ASPECT_TOLERANCE;
}

export interface StoryFitPlan {
  /** Output canvas — always the full story frame. */
  canvas: { width: number; height: number };
  /** Where the untouched source sits inside that canvas, contained and centred. */
  inner: { width: number; height: number; left: number; top: number };
  /** Which way the padding runs, for logs and tests. */
  padding: "vertical" | "horizontal";
}

/**
 * Lay the source out inside the story canvas: contain (never crop), centre.
 *
 * ⚠️ Every returned number is an EVEN integer. libx264 requires even dimensions
 * (yuv420p chroma subsampling) and rejects odd ones outright, so the same plan
 * can drive both the sharp path and the ffmpeg path. Rounding down by at most
 * one pixel per axis is invisible and can never overflow the canvas.
 */
export function planStoryFit(src: Dimensions): StoryFitPlan {
  const { width, height } = src;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`planStoryFit needs positive finite dimensions, got ${width}x${height}`);
  }

  const scale = Math.min(STORY_WIDTH / width, STORY_HEIGHT / height);
  const innerWidth = evenClamp(width * scale, STORY_WIDTH);
  const innerHeight = evenClamp(height * scale, STORY_HEIGHT);

  return {
    canvas: { width: STORY_WIDTH, height: STORY_HEIGHT },
    inner: {
      width: innerWidth,
      height: innerHeight,
      left: evenFloor((STORY_WIDTH - innerWidth) / 2),
      top: evenFloor((STORY_HEIGHT - innerHeight) / 2),
    },
    // A source WIDER than 9:16 leaves bars above and below; a narrower one
    // (e.g. 9:20 phone screenshot) leaves them at the sides.
    padding: width / height > STORY_ASPECT ? "vertical" : "horizontal",
  };
}

/** Round down to an even integer, never below 2, never above max. */
function evenClamp(value: number, max: number): number {
  const even = evenFloor(value);
  return Math.min(Math.max(even, 2), max);
}

function evenFloor(value: number): number {
  const floored = Math.floor(value);
  return floored % 2 === 0 ? floored : floored - 1;
}

/**
 * Cache key for a story rendition, so the SAME source is rendered once and then
 * reused by every channel in the fan-out (a 61-channel story must not run 61
 * identical encodes) and by every later retry.
 */
export function storyFitKey(mediaId: string): string {
  return `story916:v1:${mediaId}`;
}
