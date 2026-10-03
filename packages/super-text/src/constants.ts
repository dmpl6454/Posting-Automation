import { SUPER_TEXT_SANS_WOFF2_BASE64 } from "./fonts/plus-jakarta-sans-800-latin";
import { SUPER_TEXT_INSTAGRAM_700_WOFF2_BASE64 } from "./fonts/instagram-sans-700";
import { SUPER_TEXT_INSTAGRAM_500_WOFF2_BASE64 } from "./fonts/instagram-sans-500";
import { SUPER_TEXT_INSTAGRAM_300_WOFF2_BASE64 } from "./fonts/instagram-sans-300";

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

/**
 * Editor size presets → fontSizePct (percentage of video width).
 * M = 4.8 reproduces the owner's reference clip with the REAL Instagram Sans
 * Bold (2026-10-03, measured on a Chromium render over the reference frame):
 * cap height 37px = reference 37px, pill 156px tall vs 152, and the SAME
 * two-line break after "PVR" — at 4.6 the Bold cut still fits "Any" on line one,
 * which the reference does not. (With the Plus Jakarta stand-in the reference
 * cap height sat at 4.6; that face is no longer the default.) Pre-existing
 * configs keep whatever value they stored; the editor highlights the NEAREST preset.
 */
export const FONT_SIZE_PRESETS = { S: 3.8, M: 4.8, L: 5.8 } as const;

/* ─── Layout presets ────────────────────────────────────────────────────────
 * Geometry of the pill(s). `classic` is the pre-2026-10-02 CSS, unchanged to the
 * byte. `insta` is MEASURED off the owner's reference clip (1080×1920, strip
 * rows 1550–1701): two lines in 152px on a ~51px font; cap top 28px below the pill
 * top, descender ~10px above its bottom ⇒ line pitch ≈1.45 with ~0.12em of
 * vertical padding; text inset 33–39px ⇒ ~0.68em horizontal padding; the pill
 * spans x 87→994 = 84.0% of the width, CENTRED, with the shorter first line sharing
 * the same LEFT edge ⇒ a centred block with text-align:left. Verified by
 * re-rendering the same words over the reference frame and measuring again.
 *
 * ⚠️ `width: max-content` is load-bearing for `insta`. An absolutely positioned
 * box at left:50% shrink-wraps to the space on its RIGHT (50% of the frame), so
 * without it the strip wrapped at ~540px instead of at max-width — the classic
 * layout has always done this and is left as it was for byte-identity.
 */
export const SUPER_TEXT_LAYOUT_KEYS = ["classic", "insta"] as const;
export type SuperTextLayoutKey = (typeof SUPER_TEXT_LAYOUT_KEYS)[number];
export const DEFAULT_SUPER_TEXT_LAYOUT: SuperTextLayoutKey = "classic";

export interface SuperTextLayoutSpec {
  padYEm: number;
  padXEm: number;
  radiusEm: number;
  lineHeight: number;
  /** Width of the PILL (padding included) as % of the frame, at most. */
  maxWidthPct: number;
  textAlign: "center" | "left";
}

export const SUPER_TEXT_LAYOUTS: Record<SuperTextLayoutKey, SuperTextLayoutSpec> = {
  classic: {
    padYEm: STRIP_PAD_Y_EM,
    padXEm: STRIP_PAD_X_EM,
    radiusEm: STRIP_RADIUS_EM,
    lineHeight: STRIP_LINE_HEIGHT,
    maxWidthPct: STRIP_MAX_WIDTH_PCT,
    textAlign: "center",
  },
  insta: {
    padYEm: 0.1,
    padXEm: 0.68,
    radiusEm: 0.24,
    lineHeight: 1.5,
    // 86, not the measured 84: the room the reference's own second line needs to
    // break at the same place. Re-measured 2026-10-03 with the REAL Instagram
    // Sans cuts at M (4.8): Bold breaks after "PVR" exactly like the reference
    // (pill 848px); Medium's longer first line needs 920px = 85.2%, so 84 would
    // wrap those same words to three lines.
    maxWidthPct: 86,
    textAlign: "left",
  },
};

/** Allowlist lookup — `includes`, never `in` (see resolveSuperTextFont). */
export function resolveSuperTextLayout(key: string | undefined | null): SuperTextLayoutSpec {
  const ok =
    typeof key === "string" && (SUPER_TEXT_LAYOUT_KEYS as readonly string[]).includes(key);
  return SUPER_TEXT_LAYOUTS[ok ? (key as SuperTextLayoutKey) : DEFAULT_SUPER_TEXT_LAYOUT];
}

/* ─── Scope ─────────────────────────────────────────────────────────────────
 * `cover`: the strip is composited onto the video's cover image and that image
 * becomes the post's videoThumbnail — Instagram `cover_url`, Facebook
 * `/thumbnails`, YouTube `thumbnails.set`. The video file is untouched, so there
 * is no ffmpeg encode and a per-channel fan-out costs one small JPEG per channel.
 * `intro`: burned into the first `introSeconds` only (still a full re-encode —
 * ffmpeg must decode and re-encode the stream either way). `video`: every frame.
 */
export const SUPER_TEXT_SCOPES = ["cover", "intro", "video"] as const;
export type SuperTextScope = (typeof SUPER_TEXT_SCOPES)[number];
/** Absent key ⇒ the original full-length burn. */
export const DEFAULT_SUPER_TEXT_SCOPE: SuperTextScope = "video";
export const DEFAULT_INTRO_SECONDS = 3;

export function resolveSuperTextScope(key: string | undefined | null): SuperTextScope {
  return typeof key === "string" && (SUPER_TEXT_SCOPES as readonly string[]).includes(key)
    ? (key as SuperTextScope)
    : DEFAULT_SUPER_TEXT_SCOPE;
}

/**
 * Defaults for a NEW strip (the editor). Since 2026-10-02 these follow the
 * owner's reference clip: insta layout, the embedded sans face, the lower third
 * at 84%. Existing configs are untouched — these only seed an empty editor.
 */
export const SUPER_TEXT_DEFAULTS = {
  stripColor: "#FFFFFF",
  textColor: "#111111",
  xPct: 50,
  /** Pill centre in the reference clip: rows 1550–1701 of 1920 ⇒ 84.7%. */
  yPct: 84,
  fontSizePct: FONT_SIZE_PRESETS.M,
  /** The real Instagram Sans Bold since 2026-10-03 (owner-supplied file; the reference reel's cut). */
  font: "instagram" as const,
  layout: "insta" as const,
  /** Owner decision 2026-10-02: the strip lives on the cover, not the whole video. */
  scope: "cover" as const,
} as const;

/**
 * The reference clip's highlight orange, sampled off the burned glyphs
 * (most-saturated sample rgb(215,79,27)). First accent in the picker.
 */
export const HIGHLIGHT_ORANGE = "#D8501B";

/** Curated swatches for the per-word colour picker (plus a free colour input). */
export const WORD_COLOR_SWATCHES = [
  "#111111",
  "#FFFFFF",
  HIGHLIGHT_ORANGE,
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
export const SUPER_TEXT_FONT_KEYS = [
  "classic",
  "sans",
  "instagram",
  "instagram_medium",
  "instagram_light",
] as const;
export type SuperTextFontKey = (typeof SUPER_TEXT_FONT_KEYS)[number];

/**
 * Internal family name for the embedded Plus Jakarta face. Deliberately NOT
 * "Instagram Sans": that file is an open-licence stand-in, and the CSS family
 * name should not claim otherwise.
 */
export const EMBEDDED_SANS_FAMILY = "PA Display Sans";

/**
 * The REAL Instagram Sans (2026-10-03): three static cuts — Bold 700, Medium 500,
 * Light 300 — supplied by the owner as TTFs and embedded at their decision. ONE
 * CSS family with one @font-face per weight, so Chromium selects the cut by
 * `font-weight` and never synthesises. The family name is the font's own, which is
 * accurate here. ⚠️ It is Meta's proprietary typeface — not an open-licence face.
 * Do not publish it anywhere else (a public CDN, the marketing site, an npm package).
 */
export const EMBEDDED_INSTAGRAM_FAMILY = "Instagram Sans";

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
    // The fidelity dial — adjust here, nowhere else. 0 since 2026-10-02: measured
    // against the owner's reference clip at an identical 37px cap height, the
    // -0.02em tracking left the same two lines 6% narrower than the reference
    // (853px vs 908px); the face's natural spacing lands within 2%.
    letterSpacingEm: 0,
    embedded: { family: EMBEDDED_SANS_FAMILY, base64: SUPER_TEXT_SANS_WOFF2_BASE64 },
  },
  // The real face first, then the classic stack so a glyph it lacks (Devanagari,
  // CJK — these files are Latin-only) still resolves exactly as before. Each
  // key's weight MUST equal its @font-face weight (test-locked): all three share
  // one family name, and a mismatched descriptor would make Chromium pick — or
  // synthesise — a different cut than the preview showed.
  instagram: {
    // Bold is the cut the owner's reference reel uses (the Medium render was
    // visibly lighter side by side) — hence the default.
    label: "Instagram",
    stack: `'${EMBEDDED_INSTAGRAM_FAMILY}', ${SUPER_TEXT_FONT_STACK}`,
    weight: 700,
    letterSpacingEm: 0,
    embedded: { family: EMBEDDED_INSTAGRAM_FAMILY, base64: SUPER_TEXT_INSTAGRAM_700_WOFF2_BASE64 },
  },
  instagram_medium: {
    label: "Instagram Medium",
    stack: `'${EMBEDDED_INSTAGRAM_FAMILY}', ${SUPER_TEXT_FONT_STACK}`,
    weight: 500,
    letterSpacingEm: 0,
    embedded: { family: EMBEDDED_INSTAGRAM_FAMILY, base64: SUPER_TEXT_INSTAGRAM_500_WOFF2_BASE64 },
  },
  instagram_light: {
    label: "Instagram Light",
    stack: `'${EMBEDDED_INSTAGRAM_FAMILY}', ${SUPER_TEXT_FONT_STACK}`,
    weight: 300,
    letterSpacingEm: 0,
    embedded: { family: EMBEDDED_INSTAGRAM_FAMILY, base64: SUPER_TEXT_INSTAGRAM_300_WOFF2_BASE64 },
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
