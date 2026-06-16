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
import { safeColor, safeFontFamily, type CardSpec, type Block, type StyleControls, type FontFamily } from "./card-engine";

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
  fontFamily: FontFamily;
  background: {
    mode: LayoutBackgroundMode;
    /** Bottom scrim over a photo: "brand" = photo bleeds into the brand color
     * (moviefied blend); "dark" = legibility scrim; "none". */
    scrimMode: "dark" | "brand" | "none";
  };
  headline: {
    /** "plain" = boxless huge text on the image (moviefied); "box" = boxed bars. */
    variant: "plain" | "box";
    align: "left" | "center" | "right";
  };
  /** A brand wordmark / label sits above the headline (e.g. "Moviefied"). */
  brandLabel: boolean;
  /**
   * Whether the brand name/eyebrow has a colored underline beneath it (Round 17).
   * Per-reference, default false: a ref WITHOUT an underline (e.g. MAM) renders no
   * underline; only refs that actually show one opt in. Replaces the old behavior
   * where renderCaptionStack ALWAYS drew the 72px accent bar.
   */
  labelUnderline: boolean;
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
      align: hl.align === "center" ? "center" : hl.align === "right" ? "right" : "left",
    },
    brandLabel: lg.present === undefined ? o.brandLabel === true : o.brandLabel === true,
    // Round 17: per-reference underline under the brand label; default false.
    labelUnderline: o.labelUnderline === true,
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
    "align": "left" | "center" | "right"
  },
  "brandLabel": true | false,                        // is there a small brand name/wordmark near the headline?
  "labelUnderline": true | false,                    // does the brand name/eyebrow have a colored underline beneath it?
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
   * Accepts any value from the FontFamily union (including the Round 15 additions).
   */
  fontOverride?: FontFamily;
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
   *
   * Round 17: the styleOverride is HONORED ONLY when `hasReference` is false/undefined
   * (the picker is the fallback when NO reference is attached). When `hasReference` is
   * true, the vision-detected layout drives the look and the styleOverride is ignored.
   */
  styleOverride?: "premium_editorial" | "hook_bars" | "tweet_card" | "bold_typographic";
  /**
   * Round 17 FIX 1 — THE CORE FIX. When true, a real style reference's vision-detected
   * layout was extracted; trust `layout.background.mode`, `layout.background.scrimMode`,
   * and `layout.headline.variant` AS DETECTED and SKIP the styleOverride stomp entirely.
   * The reference drives the look; the picker is only a fallback when there is NO
   * reference (hasReference false/undefined → the styleOverride block runs as before).
   *
   * In the layout-extract rung a reference always exists, so the caller passes true —
   * EXCEPT when the vision call failed and a synthesized fallback layout was used (then
   * false, so the picker still shapes the fallback).
   */
  hasReference?: boolean;
  /**
   * Round 17 FIX 3 — the brand-LABEL (eyebrow) text color. Must be a valid hex
   * (HEX_RE-gated). DEFAULTS to the resolved headline color when not provided, so the
   * eyebrow matches the headline color by default (fixes "label turns black on
   * regenerate" — the old code used raw tokens.textColor which flipped black on a
   * light theme).
   */
  labelColor?: string;
  /**
   * Round 17 FIX 4 — explicit logo size as a % of canvas width. When unset, a
   * SHAPE-AWARE default is used (square/wordmark → larger, circle/icon → smaller),
   * because the old hard-coded 9% rendered wordmarks tiny. Clamped to [4, 40].
   */
  logoSize?: number;
  /**
   * Round 17 FIX 5 — explicit headline alignment override. When set, wins over the
   * reference's detected `layout.headline.align` (controls.textAlign + pill align).
   */
  alignOverride?: "left" | "center" | "right";
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

  // ── Round 17 FIX 1 (THE CORE FIX): the REFERENCE drives the look ──────────────
  // When a real reference layout was vision-extracted (content.hasReference === true),
  // TRUST the detected background mode / scrim / headline variant and DO NOT let the
  // picker stomp them — the whole point is that a NEW reference renders its OWN look,
  // not the picker's forced template. The picker is the FALLBACK only when there is NO
  // reference (hasReference false/undefined → the styleOverride block runs as before,
  // exactly preserving the no-reference path).
  let effectiveBgMode = layout.background.mode;
  let effectiveScrimMode = layout.background.scrimMode;
  let effectiveHeadlineVariant = layout.headline.variant;

  // Round 20: the style PICKER owns the TREATMENT (headline variant + scrim +
  // bg mode); the reference owns the CONTENT (accent color, logo position,
  // alignment, brand label, label underline). This applies EVEN when a reference
  // is attached — premium_editorial must reliably produce the Moviefied look
  // (full-bleed photo + brand-color GRADIENT scrim + boxless plain white headline)
  // regardless of what the vision model guessed for the reference's variant/scrim.
  //
  // Why this changed from R17: making the reference drive the variant + scrim threw
  // away premium's defining treatment — the headline flickered to a white "box"
  // pill (vision mis-detecting "box") and the orange gradient disappeared (vision
  // detecting scrim "none"). The picker is the user's explicit style choice, so it
  // must win on treatment; the reference still supplies the color/logo/photo.
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

  // Round 17 FIX 5: alignOverride wins over the reference's detected alignment when set.
  const effectiveAlign = content.alignOverride ?? layout.headline.align;

  const controls: StyleControls = {
    theme: layout.theme,
    brandColor,
    highlightColor: brandColor,
    bgOpacity: 100,
    fontFamily: effectiveFontFamily,
    textAlign: effectiveAlign,
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
    // Round 17 FIX 4: logo size is shape-aware by default — a "square"/wordmark logo
    // needs more width (~20%) than a "circle"/icon (~11%), because the old hard-coded
    // 9% rendered wordmarks tiny (~97px). An explicit content.logoSize wins; clamp to
    // [4, 40] to keep it sane (renderOneLogo clamps 1–100 but this is the layout ceiling).
    const shapeDefaultSize = layout.logo.shape === "square" ? 20 : 11;
    const logoSize = Math.max(4, Math.min(40, content.logoSize ?? shapeDefaultSize));
    blocks.push({
      kind: "logo",
      props: { logos: [{ kind: "image", src: content.logoUrl, anchor: layout.logo.anchor, size: logoSize, opacity: 100, ...circleBox }] },
    });
  }

  // FIX 1 (Round 15): headline text color default is scrim-aware, not just theme-aware.
  // A card with a brand-scrim (photo bleeds into brand color — the Moviefied look)
  // or a dark-scrim places the headline over a DARK surface regardless of the card's
  // overall `theme` value.  The old code used theme:"light" → black (#0f1419) which
  // gave an invisible black headline over an orange-gradient scrim.  New logic:
  //   – scrimMode "brand" or "dark" → white (#ffffff) is always legible
  //   – otherwise fall back to the existing theme heuristic
  // The user's explicit headlineColor picker value (HEX_RE-gated) still wins when set.
  const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
  const themeTextDefault =
    (effectiveScrimMode === "brand" || effectiveScrimMode === "dark")
      ? "#ffffff"
      : (layout.theme === "dark" ? "#ffffff" : "#0f1419");
  const resolvedHeadlineColor =
    content.headlineColor && HEX_RE.test(content.headlineColor)
      ? content.headlineColor
      : themeTextDefault;

  // Round 17 FIX 3: the brand-LABEL (eyebrow) color. An explicit content.labelColor
  // (HEX_RE-gated) wins; otherwise it DEFAULTS to the resolved headline color so the
  // eyebrow and headline never diverge (the old label used raw tokens.textColor →
  // flipped black on a light theme on regenerate). An invalid hex falls back to the
  // headline color (NOT the accent), matching the headlineColor sanitization posture.
  const resolvedLabelColor =
    content.labelColor && HEX_RE.test(content.labelColor)
      ? content.labelColor
      : resolvedHeadlineColor;

  // Headline (+ optional brand wordmark above it). Text + highlight markup come from
  // the repurpose flow. The variant is the picker-effective value (overrides the
  // detected variant only when there is NO reference); alignment is effectiveAlign
  // (alignOverride wins, else the reference's detected alignment).
  //
  // Round 17 FIX 2: the brand-label underline is per-reference — set from
  // layout.labelUnderline (default false), so a ref WITHOUT an underline renders none.
  // Round 17 FIX 3: the label color defaults to the headline color (resolvedLabelColor).
  blocks.push({
    kind: "captionStack",
    props: {
      ...(layout.brandLabel
        ? {
            label: {
              text: content.channelName,
              italic: true,
              underline: layout.labelUnderline === true,
              color: resolvedLabelColor,
            },
          }
        : {}),
      pills: [
        {
          text: content.headline,
          variant: effectiveHeadlineVariant,
          align: effectiveAlign,
          textColor: resolvedHeadlineColor,
        },
      ],
    },
  });

  return { canvas: { w: 1080, h: 1350 }, blocks, controls };
}
