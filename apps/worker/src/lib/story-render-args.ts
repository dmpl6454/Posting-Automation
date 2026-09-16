/**
 * The 9:16 story canvas as an ffmpeg filter fragment (2026-09-16).
 *
 * Pure and dependency-free so it can be asserted in milliseconds, like
 * video-overlay-args.ts.
 *
 * ⚠️ THIS IS A FRAGMENT, NOT A SEPARATE PASS. A story video already gets a full
 * re-encode from the watermark overlay, and a second encode per target is
 * exactly the shape of the 2026-08-07 incident (per-target ffmpeg pegged the
 * 4-core box and collapsed a 39-channel publish into 22 false FAILEDs). So the
 * padding is spliced into the FRONT of that existing filter graph and the
 * watermark then draws on the finished canvas — one download, one encode.
 *
 * ⚠️ EXPRESSION-BASED ON PURPOSE. Sizes come from ffmpeg's own runtime values
 * (force_original_aspect_ratio + centred overlay), never from probed numbers, so
 * a video carrying a rotation side-data tag — every phone portrait clip — lands
 * correctly after ffmpeg's automatic rotation. Probed width/height are the
 * PRE-rotation values and would lay a portrait clip out as landscape.
 */

export const STORY_CANVAS_WIDTH = 1080;
export const STORY_CANVAS_HEIGHT = 1920;

/** Backdrop treatment: blur hard, darken slightly, so it never competes. */
export const STORY_BACKDROP_BLUR_SIGMA = 40;
export const STORY_BACKDROP_BRIGHTNESS = -0.12;

/**
 * Fit the input onto the story canvas, padding with a blurred copy of itself.
 *
 * @param inLabel  the stream to read, e.g. "[0:v]"
 * @param outLabel the label the rest of the graph consumes, e.g. "[vfit]"
 */
export function buildStoryCanvasFilter(inLabel: string, outLabel: string): string {
  const w = STORY_CANVAS_WIDTH;
  const h = STORY_CANVAS_HEIGHT;
  return (
    `${inLabel}split=2[stbg][stfg];` +
    // Backdrop: cover the canvas, crop the overflow, blur, darken.
    `[stbg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},` +
    `gblur=sigma=${STORY_BACKDROP_BLUR_SIGMA},eq=brightness=${STORY_BACKDROP_BRIGHTNESS}[stbgb];` +
    // Foreground: contain — the whole frame, never cropped.
    `[stfg]scale=${w}:${h}:force_original_aspect_ratio=decrease[stfgs];` +
    // Centre it. W/H are the backdrop's, w/h the foreground's.
    `[stbgb][stfgs]overlay=(W-w)/2:(H-h)/2${outLabel}`
  );
}
