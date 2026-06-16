/**
 * Reference-faithful layout extraction (2026-06-15).
 *
 * A gpt-4o-mini vision call reads a style-reference image's LAYOUT/AESTHETIC —
 * NOT its text — into a small, sanitized `CardLayout` skeleton: background
 * treatment, scrim/blend, headline placement+style, brand wordmark, logo
 * position/shape, theme + dominant accent. The pure `cardLayoutToSpec` then fills
 * in OUR content (article headline, hero photo, brand logo/color) and emits a
 * `CardSpec` the block engine (`renderCard`) reproduces faithfully.
 *
 * Everything is sanitized at the parse boundary (enums whitelisted, color via
 * safeColor, confidence clamped) and again downstream in renderCard. Fails graceful
 * → null; the caller falls back to the legacy template so generation never blocks.
 */
import { safeColor, safeFontFamily, type CardSpec, type Block, type StyleControls } from "./card-engine";

/** Background treatments the extractor may pick (subset the engine renders well). */
export type LayoutBackgroundMode =
  | "photo"
  | "gradient"
  | "splitPhotos"
  | "photoGrid"
  | "screenshot"
  | "topTextBottomPhoto";

export interface CardLayout {
  theme: "light" | "dark";
  accentColor: string; // #hex, safeColor-sanitized
  /** Headline typeface family, mapped from the reference's actual font style. */
  fontFamily: import("./card-engine").FontFamily; // "inter" | "serif_display" | "condensed"
  background: {
    mode: LayoutBackgroundMode;
    /** Bottom scrim over a photo: "brand" = photo bleeds into the brand color
     * (moviefied blend); "dark" = legibility scrim; "none". */
    scrimMode: "dark" | "brand" | "none";
  };
  headline: {
    /** "plain" = boxless huge text on the image (moviefied); "box" = boxed bars. */
    variant: "plain" | "box";
    align: "left" | "center";
  };
  /** A brand wordmark / label sits above the headline (e.g. "Moviefied" + underline). */
  brandLabel: boolean;
  logo: {
    present: boolean;
    anchor: "tl" | "tr" | "bl" | "br";
    shape: "circle" | "square";
  };
  confidence: number; // 0–1
}

const BG_MODES: readonly LayoutBackgroundMode[] = [
  "photo", "gradient", "splitPhotos", "photoGrid", "screenshot", "topTextBottomPhoto",
];
const ANCHORS = ["tl", "tr", "bl", "br"] as const;

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;

/** Parse the vision model's text into a sanitized CardLayout, or null. Pure + exported. */
export function parseCardLayout(raw: string): CardLayout | null {
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let o: any;
  try {
    o = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const bg = o.background ?? {};
  const hl = o.headline ?? {};
  const lg = o.logo ?? {};
  return {
    theme: o.theme === "dark" ? "dark" : "light",
    accentColor: safeColor(typeof o.accentColor === "string" ? o.accentColor : undefined),
    fontFamily: safeFontFamily(typeof o.fontFamily === "string" ? o.fontFamily : undefined),
    background: {
      mode: oneOf(bg.mode, BG_MODES, "photo"),
      scrimMode: oneOf(bg.scrimMode, ["dark", "brand", "none"] as const, "dark"),
    },
    headline: {
      variant: hl.variant === "box" ? "box" : "plain",
      align: hl.align === "center" ? "center" : "left",
    },
    brandLabel: lg.present === undefined ? o.brandLabel === true : o.brandLabel === true,
    logo: {
      present: lg.present === true,
      anchor: oneOf(lg.anchor, ANCHORS, "tr"),
      shape: lg.shape === "square" ? "square" : "circle",
    },
    confidence: clamp01(num(o.confidence, 0)),
  };
}

const EXTRACT_PROMPT = `You are a LAYOUT analyst for Instagram-style social cards.
Look at the reference image and describe its VISUAL STYLE and LAYOUT — NOT its words.
Return ONLY this JSON (no prose):
{
  "theme": "light" | "dark",                         // overall lightness of the card
  "accentColor": "#rrggbb",                          // dominant brand/accent color
  "fontFamily": "inter" | "serif_display" | "condensed",  // headline typeface style:
                                                     //   "serif_display" = elegant serif (Playfair/Times/Georgia — premium editorial, Hollywood-style)
                                                     //   "condensed"     = tall narrow bold sans (Oswald/Bebas/Impact — bold news headlines)
                                                     //   "inter"         = clean modern sans-serif (default, minimal, tech)
  "background": {
    "mode": "photo" | "gradient" | "splitPhotos" | "photoGrid" | "screenshot" | "topTextBottomPhoto",
    "scrimMode": "brand" | "dark" | "none"           // "brand" if the photo fades into a colored gradient where the text sits
  },
  "headline": {
    "variant": "plain" | "box",                      // "plain"=big text directly on the image; "box"=text inside solid bars/boxes
    "align": "left" | "center"
  },
  "brandLabel": true | false,                        // is there a small brand name/wordmark near the headline?
  "logo": { "present": true|false, "anchor": "tl"|"tr"|"bl"|"br", "shape": "circle"|"square" },
  "confidence": 0..1
}
Pick the SINGLE best value for each field. Return ONLY the JSON.`;

/**
 * Extract a CardLayout from a reference image via gpt-4o-mini vision. Returns null
 * on any failure (missing key, network, unparseable) so the caller falls back to
 * the legacy template and generation is never blocked.
 */
export async function extractCardLayout(
  imageBase64: string,
  imageMimeType: string,
): Promise<CardLayout | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: EXTRACT_PROMPT },
              { type: "image_url", image_url: { url: `data:${imageMimeType};base64,${imageBase64}` } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[extractCardLayout] vision call failed: ${res.status}`);
      return null;
    }
    const data: any = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === "string" ? parseCardLayout(text) : null;
  } catch (e) {
    console.warn(`[extractCardLayout] error:`, (e as Error).message);
    return null;
  }
}

/** The repurpose flow's OWN content, poured into the extracted layout skeleton. */
export interface CardContent {
  headline: string;
  /** Hero/background photo (data: or https url). For split/grid, pass heroImageUrls. */
  heroImageUrl?: string;
  heroImageUrls?: string[];
  channelName: string;
  /** Brand logo image url (the user's). Absent → no logo block rendered (FIX 1). */
  logoUrl?: string;
  /** Brand accent (user's explicit color wins over the reference's detected accent). */
  brandColor?: string;
  /** Optional body for a carousel body slide (unused for the static cover). */
  body?: string;
  /**
   * When set, overrides the headline pill textColor AND the brand label color.
   * Must be a valid hex color (safeColor-gated — rejects non-hex → falls back to
   * the theme default, NOT the accent). Allows the user's font-color picker to win.
   */
  headlineColor?: string;
  /**
   * When set, overrides the font family from the reference's detected typeface.
   * The explicit pick wins; without it the reference's detected font is used.
   */
  fontOverride?: "inter" | "serif_display" | "condensed";
  /**
   * When set, the user's style PICKER overrides the vision-detected headline
   * treatment and background mode. The reference still supplies eyebrow/brandLabel,
   * logo position, colors, and theme — the picker changes only the layout treatment:
   *
   *   premium_editorial → bg mode "photo", headline variant "plain", scrimMode "brand"
   *                        (moviefied blend: photo fades into brand color)
   *   bold_typographic  → headline variant "plain" (boxless); bg mode unchanged from ref
   *   hook_bars         → headline variant "box" (boxed pill bars)
   *   tweet_card        → no override (tweet card is structurally specific; use as-detected)
   */
  styleOverride?: "premium_editorial" | "hook_bars" | "tweet_card" | "bold_typographic";
}

/**
 * Pure: map an extracted CardLayout + our content → a CardSpec the engine renders.
 * The reference dictates STRUCTURE (positions/logo/brandLabel/theme/colors); we supply
 * the TEXT and IMAGES. When content.styleOverride is set, the PICKER overrides the
 * reference-detected headline variant + background mode — the reference still supplies
 * everything else (logo anchor, brandLabel, accent, theme, alignment).
 * Exported for unit testing.
 */
export function cardLayoutToSpec(layout: CardLayout, content: CardContent): CardSpec {
  const brandColor = safeColor(content.brandColor ?? layout.accentColor);

  // ── Picker override: user's style choice wins over vision-detected treatment ──
  // The reference supplies the STRUCTURE (logo, brandLabel, positions, theme, colors);
  // the picker overrides only the headline variant + background mode.
  let effectiveBgMode = layout.background.mode;
  let effectiveScrimMode = layout.background.scrimMode;
  let effectiveHeadlineVariant = layout.headline.variant;

  if (content.styleOverride && content.styleOverride !== "tweet_card") {
    switch (content.styleOverride) {
      case "premium_editorial":
        // Moviefied look: full-bleed photo with brand-color scrim + boxless big headline.
        effectiveBgMode = "photo";
        effectiveScrimMode = "brand";
        effectiveHeadlineVariant = "plain";
        break;
      case "bold_typographic":
        // Huge headline directly on the image; keep whatever bg mode the ref has.
        effectiveHeadlineVariant = "plain";
        break;
      case "hook_bars":
        // Boxed pill headline (viral desi-news style).
        effectiveHeadlineVariant = "box";
        break;
    }
  }

  // FIX 3: fontOverride wins over the reference's detected font when the user
  // explicitly picks one; otherwise the reference's detected typeface is used.
  const effectiveFontFamily = safeFontFamily(content.fontOverride ?? layout.fontFamily);

  const controls: StyleControls = {
    theme: layout.theme,
    brandColor,
    highlightColor: brandColor,
    bgOpacity: 100,
    fontFamily: effectiveFontFamily,
    textAlign: layout.headline.align,
    logoPosition: layout.logo.anchor,
    fontScale: 1,
  };

  const blocks: Block[] = [];

  // Background: the hero photo (or split/grid tiles) with the effective scrim/blend.
  // effectiveBgMode / effectiveScrimMode are from the picker when set, else from the ref.
  blocks.push({
    kind: "background",
    props: {
      mode: effectiveBgMode,
      ...(content.heroImageUrl ? { imageUrl: content.heroImageUrl } : {}),
      ...(content.heroImageUrls?.length ? { imageUrls: content.heroImageUrls } : {}),
      accentColor: brandColor,
      scrimMode: effectiveScrimMode,
    },
  });

  // FIX 1: render a logo block ONLY when the reference has a logo AND the user
  // has supplied a logoUrl. When logoUrl is absent, render nothing — no monogram,
  // no avatar circle — so the card is clean instead of showing a blank placeholder.
  if (layout.logo.present && content.logoUrl) {
    const circleBox =
      layout.logo.shape === "circle"
        ? { box: { bg: brandColor, opacity: 100, radius: 999, pad: 14 } }
        : {};
    blocks.push({
      kind: "logo",
      props: { logos: [{ kind: "image", src: content.logoUrl, anchor: layout.logo.anchor, size: 9, opacity: 100, ...circleBox }] },
    });
  }

  // FIX 2: headline text color. When the user's picker supplies headlineColor,
  // validate it directly (same hex regex as safeColor) — only a valid hex passes.
  // Falls back to the theme default when absent or invalid (NOT to the accent, so
  // a bad value like "red;}" never corrupts the card). The brand label (small
  // eyebrow) inherits the same color so the two typographic elements are cohesive.
  const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
  const themeTextDefault = layout.theme === "dark" ? "#ffffff" : "#0f1419";
  const resolvedHeadlineColor =
    content.headlineColor && HEX_RE.test(content.headlineColor)
      ? content.headlineColor
      : themeTextDefault;

  // Headline (+ optional brand wordmark above it). Text + highlight markup come from
  // the repurpose flow. The variant is the picker-effective value (overrides detected
  // variant when styleOverride is set); alignment is always from the reference.
  blocks.push({
    kind: "captionStack",
    props: {
      ...(layout.brandLabel ? { label: { text: content.channelName, italic: true } } : {}),
      pills: [
        {
          text: content.headline,
          variant: effectiveHeadlineVariant,
          align: layout.headline.align,
          textColor: resolvedHeadlineColor,
        },
      ],
    },
  });

  return { canvas: { w: 1080, h: 1350 }, blocks, controls };
}
