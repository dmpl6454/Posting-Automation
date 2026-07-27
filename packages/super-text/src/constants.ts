/**
 * Strip geometry is expressed in `em` off ONE font-size so the live compose
 * preview (font-size = fontSizePct% of the on-screen stage width) and the worker
 * burn (fontSizePct% of the real video width) lay out identically at different
 * scales — the preview is a scaled model of the burn, not a second design.
 *
 * FONT STACK: Liberation Sans (installed in docker/Dockerfile.worker) is
 * metric-compatible with Arial (macOS/Windows preview), so line-wrap points match
 * across environments. The emoji stack is appended so colour emoji resolve on both
 * macOS (Apple Color Emoji) and the Alpine worker (Noto Color Emoji).
 * ⚠️ Single quotes inside these strings are REQUIRED — they are interpolated into
 * a style="…" attribute, where double quotes would terminate the attribute.
 */
export const SUPER_TEXT_FONT_STACK =
  "Arial, 'Liberation Sans', 'Helvetica Neue', Helvetica, sans-serif";
export const SUPER_TEXT_EMOJI_STACK =
  "'Apple Color Emoji', 'Noto Color Emoji', 'Segoe UI Emoji'";

export const STRIP_PAD_Y_EM = 0.34;
export const STRIP_PAD_X_EM = 0.55;
export const STRIP_RADIUS_EM = 0.28;
export const STRIP_LINE_HEIGHT = 1.78;
/** Strip never spans the full frame — matches Instagram's text margin. */
export const STRIP_MAX_WIDTH_PCT = 88;
export const STRIP_FONT_WEIGHT = 700;

/** Editor size presets → fontSizePct (percentage of video width). */
export const FONT_SIZE_PRESETS = { S: 3.2, M: 4.2, L: 5.4 } as const;

export const SUPER_TEXT_DEFAULTS = {
  stripColor: "#FFFFFF",
  textColor: "#111111",
  xPct: 50,
  /** Lower third — where the reference clip places it. */
  yPct: 72,
  fontSizePct: FONT_SIZE_PRESETS.M,
} as const;

/** Curated swatches for the per-word colour picker (plus a free colour input). */
export const WORD_COLOR_SWATCHES = [
  "#111111",
  "#FFFFFF",
  "#EF4444",
  "#F59E0B",
  "#10B981",
  "#3B82F6",
  "#EC4899",
] as const;
