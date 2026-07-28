import { SUPER_TEXT_SANS_WOFF2_BASE64 } from "./fonts/plus-jakarta-sans-800-latin";

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

/* ─── Font options ──────────────────────────────────────────────────────────
 * The picker's keys are a CLOSED SET and the CSS is looked up BY KEY. The config
 * value is never interpolated into the style attribute — same discipline as
 * safeHexColor, and for the same reason: a config can arrive from a restored
 * localStorage draft or a hand-written DB row, not just from our own UI.
 *
 * `classic` reproduces the pre-picker CSS exactly (same stack, same weight, and
 * NO letter-spacing declaration at all), so a config with no `font` key renders
 * byte-identically and its cached burn stays valid — the worker keys S3 objects
 * on sha1(JSON.stringify(config)).
 *
 * Plan: docs/superpowers/plans/2026-07-28-super-text-instagram-fonts.md
 */
export const SUPER_TEXT_FONT_KEYS = ["classic", "sans"] as const;
export type SuperTextFontKey = (typeof SUPER_TEXT_FONT_KEYS)[number];

/**
 * Internal family name for the embedded face. Deliberately NOT "Instagram Sans":
 * the file is DM Sans (SIL OFL), and Instagram Sans is Meta's proprietary
 * typeface — naming it that in shipped CSS would be a false claim.
 */
export const EMBEDDED_SANS_FAMILY = "PA Display Sans";

export interface SuperTextFontSpec {
  /** Shown in the editor's picker. The only place UI wording lives. */
  label: string;
  /** CSS font-family list. MUST NOT contain a double quote (test-locked). */
  stack: string;
  weight: number;
  /** 0 means "emit no letter-spacing declaration at all" (byte-identity). */
  letterSpacingEm: number;
  /** null = rely on system/OS fonts, no @font-face emitted. */
  embedded: { family: string; base64: string } | null;
}

export const DEFAULT_SUPER_TEXT_FONT: SuperTextFontKey = "classic";

export const SUPER_TEXT_FONTS: Record<SuperTextFontKey, SuperTextFontSpec> = {
  classic: {
    label: "Classic",
    stack: SUPER_TEXT_FONT_STACK,
    weight: STRIP_FONT_WEIGHT,
    letterSpacingEm: 0,
    embedded: null,
  },
  sans: {
    label: "Sans",
    // Embedded family first, then the classic stack as the fallback chain so a
    // glyph this face lacks (Devanagari, CJK) still resolves — exactly as today.
    stack: `'${EMBEDDED_SANS_FAMILY}', ${SUPER_TEXT_FONT_STACK}`,
    // 800, not 700. Plus Jakarta Sans at 700 sits too close to Arial Bold to be
    // a distinguishable second option; 800 is what makes the picker read as a
    // real choice. Must match the weight in the embedded @font-face or Chromium
    // synthesises bold and preview/burn diverge.
    weight: 800,
    // Instagram's display text is tracked tighter than the face's default. This
    // is the fidelity dial — adjust here, nowhere else.
    letterSpacingEm: -0.02,
    embedded: { family: EMBEDDED_SANS_FAMILY, base64: SUPER_TEXT_SANS_WOFF2_BASE64 },
  },
};

/**
 * Allowlist lookup — deliberately `includes` on the key array and NOT
 * `key in SUPER_TEXT_FONTS`, because `in` would match `__proto__`,
 * `constructor`, `toString` and `valueOf` and return a garbage spec.
 */
export function resolveSuperTextFont(key: string | undefined | null): SuperTextFontSpec {
  const ok =
    typeof key === "string" && (SUPER_TEXT_FONT_KEYS as readonly string[]).includes(key);
  return SUPER_TEXT_FONTS[ok ? (key as SuperTextFontKey) : DEFAULT_SUPER_TEXT_FONT];
}
