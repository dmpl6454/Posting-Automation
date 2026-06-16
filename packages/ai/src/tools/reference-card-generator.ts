/**
 * reference-card-generator — Round 10 style-mimicry via Gemini image-to-image.
 *
 * Every prior round only tinted one of 4 fixed templates. This module actually
 * REPRODUCES the reference image's composition by feeding it (and the user's hero
 * photo) to Gemini as img2img reference inputs, so the model generates a card that
 * inherits the reference's LAYOUT — header/footer/filmstrip/grid placement — not
 * just its color.
 *
 * PUBLIC SURFACE
 * ──────────────
 * generateReferenceStyledCard(args, deps) — the main entry point.
 * overlayHeadlineAndLogo(opts, browser?)   — Puppeteer-based text/logo compositor.
 *                                            Injected via ReferenceCardDeps so the
 *                                            main function is unit-testable without
 *                                            a real browser.
 *
 * THE LADDER
 * ──────────
 * When NO hero photo is supplied, the original three-rung ladder runs unchanged:
 *   1. Gemini img2img  — feeds referenceImage (+ logo) to deps.generateImage.
 *      Returns engine: "gemini-img2img". MOST FAITHFUL (non-person references).
 *   2. OpenAI described — on rung-1 failure: vision-describe the reference via
 *      deps.describeImageStyle, build a text-to-image prompt, call
 *      deps.generateImageDallE. Returns engine: "openai-described". APPROXIMATION.
 *   3. Template fallback — both rungs failed: returns engine: "template" with
 *      imageBase64: "" and mimeType: "". The CALLER interprets "template" as
 *      "fall back to the existing renderStaticCreative/buildStaticCreative path."
 *      This module does NOT re-implement any template renderer.
 *
 * When a HERO photo IS supplied (the Bollywood-celebrity-news case), a new rung
 * is tried FIRST — the COMPOSITE path (engine "gemini-composite"):
 *   0. Gemini composite — recreate the reference's LAYOUT via Gemini with the main
 *      photo region rendered as a flat MAGENTA SENTINEL fill (NO person passed to
 *      Gemini, so its policy layer can't refuse on a famous face). Detect the
 *      sentinel rectangle in the Gemini output, then deterministically paste the
 *      user's REAL hero photo into that region via Puppeteer. Result = the
 *      reference's true layout + the REAL face, NEVER AI-altered. BEST + SAFEST.
 *      If the sentinel call is refused/fails OR no sentinel region is detected,
 *      the ladder falls through to rung-1 (gemini-img2img) → rung-2 → rung-3.
 *   The composite rung is SKIPPED entirely when no hero photo is provided.
 *
 * TEXT MODES
 * ──────────
 * "ai"      — The generation prompt asks the model to render the headline text
 *             inside the reference's layout. One generation call; most faithful.
 * "overlay" — The generation prompt tells the model to leave the headline area
 *             as clean negative space. After generation, deps.overlayHeadlineAndLogo
 *             composites the exact headline + logo deterministically onto the
 *             background. Guarantees legible, correct text even if the model garbles it.
 *
 * DEPENDENCY INJECTION
 * ────────────────────
 * All I/O-heavy helpers (Gemini generate, OpenAI vision/image, Puppeteer overlay)
 * are injected via ReferenceCardDeps. Real callers pass the production impls;
 * tests inject mocks. This pattern mirrors how renderStaticCreative takes an `ai`
 * object in the router.
 *
 * SECURITY
 * ────────
 * - brandColor   → safeColor() (strict hex allow-list).
 * - headline, brandName, handle → escapeHtml() before any HTML interpolation.
 * - logoUrl (if URL)  → isPublicImageUrl() gate (matches overlayLogoOnImage).
 * - logoBase64 (data URL) → safe by construction.
 * - bg image data URL → trusted (we generated it); interpolated as-is.
 * - See overlayHeadlineAndLogo for detailed per-field notes.
 */

import puppeteer from "puppeteer";
import { safeColor, safeFontFamily, escapeHtml, safeImageUrl } from "./card-engine";
import { isPublicImageUrl } from "../utils/safe-fetch-url";
import { extractCardLayout, cardLayoutToSpec, type CardLayout } from "./extract-card-layout";
import { generateCardImage } from "./news-image-generator";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RefImageInput {
  base64: string;
  mimeType: string;
}

export interface GenerateReferenceStyledCardArgs {
  /** The style reference image — the primary img2img input. */
  referenceImage: RefImageInput;
  /** User's hero / article photo; placed into the reference's photo region. */
  heroImage?: RefImageInput;
  headline: string;
  brandName: string;
  handle?: string;
  logoImage?: RefImageInput;
  /**
   * Brand accent color (hex, e.g. "#ff7a00"). Passed as a prompt hint only.
   * Gated through safeColor before any interpolation.
   */
  brandColor?: string | null;
  textMode: "ai" | "overlay";
  /**
   * The user's style picker choice. When set, the layout-extract rung passes this
   * through to cardLayoutToSpec as `styleOverride`, so the picker overrides the
   * vision-detected headline variant + background mode while the reference still
   * supplies logo position, brandLabel, colors, and theme.
   * Has no effect on the Gemini img2img or OpenAI-described rungs (those use
   * prompt-based generation, not the block engine).
   */
  styleOverride?: string;
  /**
   * User's headline font-color picker value (hex). Forwarded to cardLayoutToSpec
   * as content.headlineColor on the layout-extract rung. safeColor-gated there.
   * Has no effect on the Gemini img2img or OpenAI-described rungs.
   */
  headlineColor?: string;
  /**
   * User's font-family picker value. Forwarded to cardLayoutToSpec as
   * content.fontOverride on the layout-extract rung. The explicit pick wins over
   * the reference's detected font. Has no effect on the generation-based rungs.
   * Accepts any value from the FontFamily union (including Round 15 additions).
   */
  fontOverride?: import("./card-engine").FontFamily;
  /**
   * Round 17 FIX 3 — user's brand-LABEL (eyebrow) color picker value (hex). Forwarded
   * to cardLayoutToSpec as content.labelColor on the layout-extract rung. Defaults to
   * the headline color there when unset. safeColor/HEX_RE-gated. No effect on the
   * generation-based rungs.
   */
  labelColor?: string;
  /**
   * Round 17 FIX 4 — explicit logo size (% of canvas width). Forwarded to
   * cardLayoutToSpec as content.logoSize on the layout-extract rung. When unset a
   * shape-aware default is used there. Clamped [4, 40]. No effect on the
   * generation-based rungs.
   */
  logoSize?: number;
  /**
   * Round 17 FIX 5 — explicit headline alignment override. Forwarded to
   * cardLayoutToSpec as content.alignOverride on the layout-extract rung; wins over
   * the reference's detected alignment. No effect on the generation-based rungs.
   */
  alignOverride?: "left" | "center" | "right";
}

export type ReferenceCardEngine =
  | "gemini-composite"
  | "layout-extract"
  | "gemini-img2img"
  | "openai-described"
  | "template";

export interface GenerateReferenceStyledCardResult {
  imageBase64: string;
  mimeType: string;
  engine: ReferenceCardEngine;
}

// ── Overlay primitive types ───────────────────────────────────────────────────

export interface OverlayHeadlineArgs {
  imageBase64: string;
  mimeType: string;
  width: number;   // 1080
  height: number;  // 1350
  headline: string;
  brandName?: string;
  handle?: string;
  /** Optional logo as a public URL (isPublicImageUrl-gated; falls back to monogram on block). */
  logoUrl?: string;
  /** Optional logo as inline base64 (data: url — safe by construction). */
  logoBase64?: string;
  logoMimeType?: string;
  brandColor?: string | null;
  /** Optional shared Puppeteer browser. When provided only a new page is opened. */
  browser?: import("puppeteer").Browser;
}

// ── Composite primitive types ─────────────────────────────────────────────────

/** A rectangle in image pixel coordinates. */
export interface SentinelBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CompositeHeroArgs {
  /** The Gemini-generated base card (with the magenta sentinel region). */
  baseImageBase64: string;
  baseMimeType: string;
  /** The detected sentinel rectangle to paste the hero photo into (image coords). */
  region: SentinelBBox;
  /** Output dimensions of the base card (Gemini renders 1080×1350). */
  width: number;
  height: number;
  /**
   * The user's REAL hero photo. Either inline base64 (data: url — safe by
   * construction, the prod path) or a public URL (isPublicImageUrl-gated).
   */
  heroBase64?: string;
  heroMimeType?: string;
  heroUrl?: string;
  /** Optional shared Puppeteer browser. When provided only a new page is opened. */
  browser?: import("puppeteer").Browser;
}

// ── Dependency injection contract ─────────────────────────────────────────────

export interface ReferenceCardDeps {
  /**
   * Gemini multi-image generate (nano-banana provider's generateImage in prod).
   * Pass referenceImages as [{base64, mimeType?}, ...] for img2img conditioning.
   */
  generateImage: (params: {
    prompt: string;
    aspectRatio?: string;
    referenceImages?: Array<{ base64: string; mimeType?: string }>;
  }) => Promise<{ imageBase64: string; mimeType: string; text?: string }>;

  /**
   * OpenAI vision style describe (describeImageStyle from describe-image-style.ts).
   * Returns a ≤300-char style descriptor or null on any failure.
   */
  describeImageStyle: (base64: string, mimeType: string) => Promise<string | null>;

  /**
   * OpenAI text-to-image (generateImageDallE — gpt-image-1 under the hood).
   * NOTE: do NOT pass response_format; gpt-image-1 returns b64 by default.
   */
  generateImageDallE: (params: {
    prompt: string;
    size?: string;
    quality?: string;
  }) => Promise<{ imageBase64: string; mimeType: string; text?: string }>;

  /**
   * Puppeteer-based headline + logo compositor.
   * In prod, pass the overlayHeadlineAndLogo exported below.
   * In tests, pass a mock so Puppeteer is never launched.
   */
  overlayHeadlineAndLogo: (opts: OverlayHeadlineArgs) => Promise<{ imageBase64: string; mimeType: string }>;

  /**
   * Detect the magenta SENTINEL rectangle in a Gemini-generated base card.
   * Loads the PNG into an offscreen canvas, reads its pixels, and runs the pure
   * findSentinelBBox scan. Returns null when no sufficiently-large magenta region
   * is found (Gemini ignored the sentinel instruction) — the caller then advances
   * to the next ladder rung instead of pasting into a bogus box.
   *
   * OPTIONAL: when omitted, the composite rung uses the exported (Puppeteer-backed)
   * detectSentinelRegion. The router relies on this default; tests inject a mock so
   * no browser launches. The composite rung is only reached when a hero exists, so
   * callers that never pass a hero (existing behavior) never touch it.
   */
  detectSentinelRegion?: (params: {
    imageBase64: string;
    mimeType: string;
  }) => Promise<SentinelBBox | null>;

  /**
   * Paste the user's REAL hero photo into the detected sentinel region of the
   * Gemini base card via Puppeteer (object-fit: cover, clipped to the box). The
   * hero's face is pixel-real — NEVER touched by an AI model.
   *
   * OPTIONAL: when omitted, the composite rung uses the exported compositeHeroIntoRegion.
   * The router relies on this default; tests inject a mock so Puppeteer never launches.
   */
  compositeHeroIntoRegion?: (opts: CompositeHeroArgs) => Promise<{ imageBase64: string; mimeType: string }>;

  /**
   * OPTIONAL: OpenAI-vision layout extractor (extractCardLayout from
   * extract-card-layout.ts). Given a reference image as base64 + mimeType, returns
   * a CardLayout skeleton describing the reference's composition, or null on failure.
   * Defaults to the real impl when omitted (the router relies on this default).
   * Tests inject a mock so no real OpenAI call is made.
   */
  extractCardLayout?: (imageBase64: string, imageMimeType: string) => Promise<unknown | null>;

  /**
   * OPTIONAL: block-engine renderer for the layout-extract rung. Given a CardLayout
   * (as returned by extractCardLayout) and the card content, returns a PNG.
   * Defaults to (layout, content) => generateCardImage(cardLayoutToSpec(layout, content)).
   * Tests inject a mock so Puppeteer is never launched.
   * `content.styleOverride` (when present) is forwarded to cardLayoutToSpec so the
   * user's picker overrides the vision-detected headline variant + background mode.
   */
  renderLayoutCard?: (layout: unknown, content: {
    headline: string;
    heroImageUrl?: string;
    channelName: string;
    logoUrl?: string;
    brandColor?: string;
    styleOverride?: string;
    headlineColor?: string;
    fontOverride?: import("./card-engine").FontFamily;
    /** Round 17: when true, the reference's detected layout drives the look (picker skipped). */
    hasReference?: boolean;
    labelColor?: string;
    logoSize?: number;
    alignOverride?: "left" | "center" | "right";
  }) => Promise<{ imageBase64: string; mimeType: string }>;
}

// ── Internal constants ────────────────────────────────────────────────────────

/**
 * Safety clauses for the generation prompts.
 *
 * The naive "do NOT depict any real recognizable person" clause BLOCKS the core
 * use case: this feature recreates news/celebrity social cards whose hero photo
 * legitimately IS a real person the user supplied. A blanket ban made Gemini
 * refuse with finishReason OTHER on every celebrity reference (verified on the
 * visual gate). The fix distinguishes the two cases:
 *   - WITH a hero photo: PRESERVE the user's supplied person as-is; the only ban
 *     is fabricating a DIFFERENT real named identity (deepfake risk).
 *   - WITHOUT a hero photo: keep the stricter no-real-person ban (we'd otherwise
 *     be inventing a likeness from nothing).
 * Both forbid gibberish text + hashtags (same as the router's image path).
 */
const SAFETY_CLAUSE_WITH_HERO =
  "\n\nIMPORTANT: Use the user's supplied photo (the second image) as the subject exactly as given — do NOT alter, swap, or fabricate a different real person's face or identity. Do NOT include hashtag text. Any text you render must be clean, legible, correctly spelled, and limited to the provided headline and brand wordmark — no gibberish or placeholder lorem text.";

const SAFETY_CLAUSE_NO_HERO =
  "\n\nIMPORTANT: Do NOT depict any real, recognizable named person (no hero photo was provided). Do NOT include hashtag text. Any text you render must be clean, legible, correctly spelled, and limited to the provided headline and brand wordmark — no gibberish or placeholder lorem text.";

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1350;

// ── Composite-path constants ────────────────────────────────────────────────
//
// The COMPOSITE path recreates the reference's layout via Gemini but renders the
// main photo region as a flat magenta SENTINEL rectangle — NO person is passed to
// Gemini, so its policy layer cannot refuse on a famous face. We then detect that
// magenta block and paste the user's REAL hero photo into it locally (Puppeteer).
//
// Detection tolerates Gemini not honoring the hex exactly: a pixel counts as
// "sentinel" when it's strongly magenta-ish (high R, low G, high B). The threshold
// is deliberately loose on R/B and strict on G so warm/cool magenta variants pass
// while skin tones, accent oranges, and photo content do not.

/** Sentinel fill color asked of Gemini (pure magenta). */
const SENTINEL_HEX = "#FF00FF";

/** Per-channel thresholds for "is this pixel magenta-ish?" — see findSentinelBBox. */
const SENTINEL_R_MIN = 180;
const SENTINEL_G_MAX = 90;
const SENTINEL_B_MIN = 180;

/**
 * The detected sentinel region must cover at least this fraction of the card to be
 * trusted. Below it we assume Gemini ignored the instruction (scattered magenta
 * noise) and return null so the caller advances to the next rung.
 */
const SENTINEL_MIN_AREA_FRACTION = 0.02;

// ── Prompt builders ───────────────────────────────────────────────────────────

/**
 * Build the Gemini img2img prompt for one of the two text modes.
 *
 * Prompt is intentionally verbose so Gemini's layout-understanding is fully
 * engaged: we name every structural element (eyebrow, headline, filmstrip,
 * footer) to prime spatial reasoning. Do NOT remove the numbered image refs —
 * Gemini uses them to disambiguate when multiple reference images are passed.
 */
function buildGeminiPrompt(
  args: GenerateReferenceStyledCardArgs,
  hasHero: boolean,
): string {
  const colorHint = safeColor(args.brandColor ?? undefined);
  const headline = args.headline.slice(0, 120); // cap for parity with buildOpenAIPrompt (cost/length safety)

  const headlineInstruction =
    args.textMode === "ai"
      ? `Place this exact headline text where the reference's headline sits, matching its font weight, size, alignment, and any partial-bold emphasis: "${headline}".`
      : `Leave the headline text area as clean, empty negative space — DO NOT render any headline text, words, or letters in it. Keep the layout, eyebrow, photo region(s), filmstrip, footer, and color treatment of the reference.`;

  const heroInstruction = hasHero
    ? `Place the SECOND image (the user's photo) into the reference's main photo region, cropped/scaled to fill it the same way — keep that person exactly as supplied.`
    : "";

  return [
    `You are a graphic designer recreating a social-media card TEMPLATE. Study the FIRST image (the reference) and reproduce its LAYOUT precisely as a new card: the same overall grid and proportions, the same photo region position and shape, the same eyebrow/label placement, the same headline position and alignment, any image strip / filmstrip rows, any footer or brand bar, and the same color/gradient treatment and typography style.`,
    heroInstruction,
    headlineInstruction,
    `Use this brand accent color where the reference uses its accent: ${colorHint}. Keep the same overall look and feel as the reference.`,
    `This is a layout/template design task — match the reference's composition, not its specific content. Output a single finished 1080x1350 (4:5 portrait) social media card image.`,
    hasHero ? SAFETY_CLAUSE_WITH_HERO : SAFETY_CLAUSE_NO_HERO,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Build the Gemini SENTINEL prompt for the composite (rung-0) path.
 *
 * Unlike buildGeminiPrompt, this NEVER passes the hero to Gemini and explicitly
 * asks for the main photo region to be a flat, uniform solid MAGENTA fill with no
 * person/photo/texture. That removes the famous-face Gemini refuses on, while still
 * recreating every OTHER element of the reference (eyebrow, headline, filmstrip,
 * footer, background, colors). We paste the real hero into the magenta box later.
 *
 * No-hero safety clause is intentional: by design no real person is in this
 * generation — the magenta region is a placeholder. The clause forbids inventing a
 * likeness anywhere in the card and bans gibberish text, same as the other rungs.
 */
function buildSentinelPrompt(args: GenerateReferenceStyledCardArgs): string {
  const colorHint = safeColor(args.brandColor ?? undefined);
  const headline = args.headline.slice(0, 120);

  const headlineInstruction =
    args.textMode === "ai"
      ? `Place this exact headline text where the reference's headline sits, matching its font weight, size, alignment, and any partial-bold emphasis: "${headline}".`
      : `Leave the headline text area as clean, empty negative space — DO NOT render any headline text, words, or letters in it.`;

  return [
    `You are a graphic designer recreating a social-media card TEMPLATE. Study the FIRST image (the reference) and reproduce its LAYOUT precisely as a new card: the same overall grid and proportions, the same photo region position and shape, the same eyebrow/label placement, the same headline position and alignment, any image strip / filmstrip rows, any footer or brand bar, and the same color/gradient treatment and typography style.`,
    `CRITICAL — the MAIN PHOTO AREA: render it as a perfectly FLAT, uniform, solid SENTINEL fill of pure magenta ${SENTINEL_HEX}. There must be NO photo, NO person, NO face, NO texture, and NO gradient inside that region — leave it a clean solid magenta rectangle that I will replace afterward. Keep its exact position, size, and shape matching the reference's photo region. Do NOT use magenta anywhere else on the card.`,
    headlineInstruction,
    `Use this brand accent color where the reference uses its accent: ${colorHint}. Keep the same overall look and feel as the reference (but the photo region stays solid magenta).`,
    `This is a layout/template design task — match the reference's composition, not its specific content. Output a single finished 1080x1350 (4:5 portrait) social media card image.`,
    SAFETY_CLAUSE_NO_HERO,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Build the OpenAI gpt-image-1 text-to-image prompt for rung-2.
 *
 * Uses the style descriptor from describeImageStyle so the reference's visual
 * language is approximated even though gpt-image-1 cannot accept image inputs.
 * Prompt is length-bounded: descriptor capped at 300 chars by describeImageStyle;
 * headline capped at 120 chars here for safety.
 */
function buildOpenAIPrompt(
  args: GenerateReferenceStyledCardArgs,
  styleDescriptor: string | null,
): string {
  const colorHint = safeColor(args.brandColor ?? undefined);
  const headline = args.headline.slice(0, 120);
  const descriptor = styleDescriptor ?? "editorial social media card";

  const textInstruction =
    args.textMode === "ai"
      ? `Headline: "${headline}"`
      : `Leave the headline region as clean, empty negative space — do NOT render any headline text or words.`;

  return [
    `Create a 1080x1350 social media card in this visual style: ${descriptor}.`,
    `Layout: portrait social card with header area, main content, and footer.`,
    textInstruction,
    `Brand accent color: ${colorHint}.`,
    // gpt-image-1 fabricates from text only (no hero photo input), so use the
    // stricter no-real-person clause regardless of whether a hero exists.
    SAFETY_CLAUSE_NO_HERO,
  ].join(" ");
}

// ── Pure sentinel-region scanner (browser-free, unit-testable) ─────────────────

/**
 * Scan an RGBA pixel buffer for the magenta SENTINEL region and return its
 * bounding box in image pixel coordinates, or null when none is found.
 *
 * PURE — no browser, no I/O. Extracted so the pixel math is unit-testable on a
 * small synthetic Uint8ClampedArray. The Puppeteer-backed detectSentinelRegion
 * (below) reads getImageData and delegates the actual scan to this function.
 *
 * Algorithm:
 *  - Treat a pixel as "sentinel" when R > SENTINEL_R_MIN && G < SENTINEL_G_MAX &&
 *    B > SENTINEL_B_MIN (strongly magenta-ish; tolerant of Gemini not honoring
 *    #FF00FF exactly).
 *  - Track the min/max x and y of all matching pixels → bounding box.
 *  - Reject (return null) when no pixel matches OR the box area is below
 *    SENTINEL_MIN_AREA_FRACTION of the image (scattered noise, not a real region).
 *
 * @param data   RGBA bytes, length === width * height * 4.
 * @param width  image width in pixels.
 * @param height image height in pixels.
 * @param step   sample stride (default 4 → every 4th pixel, for speed). The bbox
 *               is widened by `step` on the max edges to cover skipped pixels.
 */
export function findSentinelBBox(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  step = 4,
): SentinelBBox | null {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return null;
  const stride = Math.max(1, Math.floor(step));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let matched = 0;

  for (let y = 0; y < height; y += stride) {
    const rowBase = y * width * 4;
    for (let x = 0; x < width; x += stride) {
      const i = rowBase + x * 4;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      if (r > SENTINEL_R_MIN && g < SENTINEL_G_MAX && b > SENTINEL_B_MIN) {
        matched++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (matched === 0) return null;

  // Widen the max edges by the stride so the box covers pixels we skipped, then
  // clamp to image bounds.
  const x = Math.max(0, minX);
  const y = Math.max(0, minY);
  const right = Math.min(width, maxX + stride);
  const bottom = Math.min(height, maxY + stride);
  const w = right - x;
  const h = bottom - y;

  if (w <= 0 || h <= 0) return null;
  if ((w * h) / (width * height) < SENTINEL_MIN_AREA_FRACTION) return null;

  return { x, y, w, h };
}

// ── Composite path (rung-0) ────────────────────────────────────────────────────

/**
 * The COMPOSITE celebrity-face path.
 *
 * Steps:
 *  1. Ask Gemini to recreate the reference's LAYOUT with the main photo region as
 *     a flat magenta SENTINEL fill. The hero is NOT passed to Gemini (passing a
 *     famous face re-triggers the policy refusal), so only the reference image is
 *     conditioned on.
 *  2. Detect the magenta sentinel rectangle in the Gemini output (deps.detectSentinelRegion
 *     → findSentinelBBox). If none is found (Gemini ignored the instruction), bail.
 *  3. Paste the user's REAL hero photo into the detected rectangle via Puppeteer
 *     (deps.compositeHeroIntoRegion). The face is pixel-real — never AI-altered.
 *  4. In "overlay" textMode, composite the headline + logo deterministically over
 *     the result (Gemini was told to leave the headline area empty).
 *
 * Returns the finished card with engine "gemini-composite", or null on ANY failure
 * (Gemini refused/threw/empty, no sentinel detected, or composite step failed) so
 * the caller advances to the next ladder rung. Never throws.
 *
 * Precondition: args.heroImage is defined (caller gates on it). If absent, returns
 * null immediately — the composite has nothing to paste.
 */
export async function generateCompositeStyledCard(
  args: GenerateReferenceStyledCardArgs,
  deps: ReferenceCardDeps,
): Promise<GenerateReferenceStyledCardResult | null> {
  const { referenceImage, heroImage, textMode } = args;
  if (!heroImage) return null;

  try {
    // Step 1: Gemini renders the layout with a magenta sentinel photo region.
    // ONLY the reference image is conditioned on — the hero is NEVER sent (a famous
    // face re-triggers the refusal that this whole path exists to avoid).
    const prompt = buildSentinelPrompt(args);
    const base = await deps.generateImage({
      prompt,
      aspectRatio: "4:5",
      referenceImages: [{ base64: referenceImage.base64, mimeType: referenceImage.mimeType }],
    });
    if (!base.imageBase64) {
      console.warn("[reference-card-generator] Rung-0: Gemini returned empty sentinel card.");
      return null;
    }

    // Step 2: detect the magenta sentinel rectangle. Use the injected detector if
    // present (tests), else the exported Puppeteer-backed impl (router/prod default).
    const detect = deps.detectSentinelRegion ?? detectSentinelRegion;
    const region = await detect({
      imageBase64: base.imageBase64,
      mimeType: base.mimeType,
    });
    if (!region) {
      console.warn("[reference-card-generator] Rung-0: no sentinel region detected — bailing.");
      return null;
    }

    // Step 3: paste the REAL hero photo into the detected region (face never AI-altered).
    // Use the injected compositor if present (tests), else the exported impl.
    const composite = deps.compositeHeroIntoRegion ?? compositeHeroIntoRegion;
    const composited = await composite({
      baseImageBase64: base.imageBase64,
      baseMimeType: base.mimeType,
      region,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      heroBase64: heroImage.base64,
      heroMimeType: heroImage.mimeType,
    });
    if (!composited.imageBase64) {
      console.warn("[reference-card-generator] Rung-0: composite step returned empty image.");
      return null;
    }

    // Step 4: in overlay mode, composite the headline + logo deterministically over
    // the result (Gemini left the headline area as negative space).
    if (textMode === "overlay") {
      const withText = await deps.overlayHeadlineAndLogo(
        buildOverlayArgs(args, composited.imageBase64, composited.mimeType),
      );
      return { imageBase64: withText.imageBase64, mimeType: withText.mimeType, engine: "gemini-composite" };
    }

    return { imageBase64: composited.imageBase64, mimeType: composited.mimeType, engine: "gemini-composite" };
  } catch (err) {
    console.warn("[reference-card-generator] Rung-0 (Gemini composite) failed:", (err as Error).message);
    return null;
  }
}

// ── Layout-extract path (the RELIABLE celebrity-face rung) ────────────────────

/**
 * Default block-engine renderer for the layout-extract rung.
 * Converts a CardLayout (from extractCardLayout) + card content into a PNG via
 * cardLayoutToSpec → generateCardImage. Defined at module level (not inline) so
 * it is stable across calls and avoids allocation on the hot path.
 */
async function defaultRenderLayoutCard(
  layout: unknown,
  content: {
    headline: string;
    heroImageUrl?: string;
    channelName: string;
    logoUrl?: string;
    brandColor?: string;
    styleOverride?: string;
    headlineColor?: string;
    fontOverride?: import("./card-engine").FontFamily;
    hasReference?: boolean;
    labelColor?: string;
    logoSize?: number;
    alignOverride?: "left" | "center" | "right";
  },
): Promise<{ imageBase64: string; mimeType: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spec = cardLayoutToSpec(layout as any, content as any);
  const r = await generateCardImage(spec);
  return { imageBase64: r.imageBase64, mimeType: r.mimeType };
}

/**
 * The LAYOUT-EXTRACT rung — the RELIABLE celebrity-face path.
 *
 * Uses OpenAI vision to read the reference image's LAYOUT structure (tolerates
 * celebrity faces in the reference — it reads composition, not identity), then
 * deterministically reproduces that layout via the block engine with the REAL hero
 * photo. No Gemini, no refusal, no AI-altered faces.
 *
 * Steps:
 *  1. Call extractCardLayout (OpenAI gpt-4o-mini vision) → CardLayout skeleton
 *     describing the reference's background mode, scrim, headline placement, logo
 *     anchor, theme, and accent. Returns null on any failure → this rung bails.
 *  2. Build a hero data URL from args.heroImage (the real photo — pixel-perfect).
 *  3. Call cardLayoutToSpec (pure) → fill in OUR headline/hero/brand content.
 *  4. Call generateCardImage (Puppeteer block engine) → 1080×1350 PNG.
 *
 * Returns { imageBase64, mimeType, engine: "layout-extract" } on success, or null
 * on ANY failure (extractCardLayout returned null, render threw, empty output). Never
 * throws — the caller advances to the next ladder rung on null.
 *
 * Precondition: args.heroImage is defined (the caller gates on it). Returns null
 * immediately when absent — the layout has nothing to place in the photo slot.
 *
 * NOTE: textMode does NOT apply here. The block engine always renders the headline
 * deterministically from the CardSpec — that IS the "always correct text" property
 * and is exactly what we want for the reliable path.
 */
export async function generateLayoutExtractCard(
  args: GenerateReferenceStyledCardArgs,
  deps: ReferenceCardDeps,
): Promise<GenerateReferenceStyledCardResult | null> {
  const { referenceImage, heroImage, logoImage } = args;

  // FIX 1(b) (Round 16): a hero photo is NOT required to render. When MIMICRY INTENT
  // exists (the user picked a style → args.styleOverride is set) but the hero photo is
  // unfetchable (e.g. NDTV hard-403s server-side image fetches), render the layout
  // DETERMINISTICALLY WITHOUT a photo — a clean branded card (the background block
  // falls back to the branded gradient in renderBackground when no imageUrl is given;
  // scrim/colors/eyebrow/headline are still placed). This replaces the old
  // `if (!heroImage) return null` that silently degraded NDTV-class URLs to the
  // fake-AI-face rungs (gemini-img2img / openai-described fabricates a face).
  //
  // We KEY ON styleOverride (not just the always-present referenceImage) so the
  // EXISTING no-hero Gemini-ladder behavior is preserved when there is no mimicry
  // intent: with no hero AND no styleOverride we bail to the original ladder below.
  // In production the Repurpose mimicry path always passes styleOverride (= the
  // user's picked creativeStyle), so a photoless NDTV-class card always renders here.
  if (!heroImage && !args.styleOverride) return null;

  try {
    // Step 1: vision-extract the reference's layout. Tolerates celebrity faces —
    // we are reading COMPOSITION (grid, scrim, headline position) not identity.
    const extract = deps.extractCardLayout ?? extractCardLayout;
    const rawLayout = await extract(referenceImage.base64, referenceImage.mimeType);

    // FIX 3 (Round 15): when extractCardLayout returns null (vision rate-limit,
    // quota, timeout, or OpenAI key absent), synthesize a deterministic fallback
    // CardLayout from the user's own brand color + font picker instead of bailing
    // out and falling through to the slow "openai-described" rung. The fallback
    // produces a clean premium_editorial card (photo + brand-scrim + plain
    // headline) which is always correct and visually consistent. The user's
    // styleOverride (passed in via content.styleOverride below) still overrides
    // the headline variant, so a picker choice is respected even on vision failure.
    const fallbackLayout: CardLayout = {
      theme: "dark",
      accentColor: safeColor(args.brandColor ?? undefined),
      fontFamily: safeFontFamily(args.fontOverride),
      background: { mode: "photo", scrimMode: "brand" },
      headline: { variant: "plain", align: "left" },
      brandLabel: !!args.brandName,
      // Round 17 FIX 2: the synthesized fallback has no real detected underline → off.
      labelUnderline: false,
      logo: { present: false, anchor: "tr", shape: "circle" },
      confidence: 0,
    };

    // Round 17 FIX 1: hasReference is true ONLY when a REAL vision-extracted layout was
    // used. When the fallback was synthesized (vision failed), there's no detected
    // layout to trust, so hasReference is false and the picker (styleOverride) still
    // shapes the fallback in cardLayoutToSpec.
    const usedRealLayout = !!rawLayout;
    const layout: unknown = rawLayout ?? fallbackLayout;
    if (!rawLayout) {
      console.warn("[reference-card-generator] Layout-extract rung: extractCardLayout returned null — using fallback layout.");
    }

    // Step 2: build the hero data URL (the user's REAL photo — never AI-touched).
    // FIX 1(b): heroImage is optional now — when absent (unfetchable photo), omit
    // heroImageUrl entirely. cardLayoutToSpec's background block then renders with
    // no imageUrl, and renderBackground falls back to the branded gradient (mode
    // "photo" with no url → `grad`), giving a clean photoless branded card.
    const heroDataUrl = heroImage
      ? `data:${heroImage.mimeType};base64,${heroImage.base64}`
      : undefined;

    // Step 3: build logo URL if a logo image is provided.
    // safeImageUrl gates the assembled data: URL to block attribute-breakout mimeTypes.
    const logoUrl = logoImage
      ? safeImageUrl(`data:${logoImage.mimeType};base64,${logoImage.base64}`) ?? undefined
      : undefined;

    // Step 4: render via the block engine.
    // styleOverride (when set) is forwarded so the user's picker overrides the
    // vision-detected headline variant + background mode in cardLayoutToSpec.
    const render = deps.renderLayoutCard ?? defaultRenderLayoutCard;
    const out = await render(layout, {
      headline: args.headline,
      ...(heroDataUrl ? { heroImageUrl: heroDataUrl } : {}),
      channelName: args.brandName,
      ...(logoUrl ? { logoUrl } : {}),
      ...(args.brandColor ? { brandColor: safeColor(args.brandColor) } : {}),
      ...(args.styleOverride ? { styleOverride: args.styleOverride } : {}),
      ...(args.headlineColor ? { headlineColor: args.headlineColor } : {}),
      ...(args.fontOverride ? { fontOverride: args.fontOverride } : {}),
      // Round 17: a REAL vision-extracted layout drives the look (picker skipped);
      // the synthesized fallback does not (picker still shapes it).
      hasReference: usedRealLayout,
      ...(args.labelColor ? { labelColor: args.labelColor } : {}),
      ...(args.logoSize != null ? { logoSize: args.logoSize } : {}),
      ...(args.alignOverride ? { alignOverride: args.alignOverride } : {}),
    });

    if (!out.imageBase64) {
      console.warn("[reference-card-generator] Layout-extract rung: renderLayoutCard returned empty image.");
      return null;
    }

    return { imageBase64: out.imageBase64, mimeType: out.mimeType, engine: "layout-extract" };
  } catch (err) {
    console.warn("[reference-card-generator] Layout-extract rung failed:", (err as Error).message);
    return null;
  }
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Generate a 1080×1350 social card that recreates the reference image's LAYOUT.
 *
 * Ladder:
 *   0. Gemini composite  → engine: "gemini-composite"  (ONLY when heroImage exists,
 *      tried FIRST — Gemini renders the layout with a magenta sentinel photo region,
 *      the real hero photo is pasted into it locally; the face is never AI-altered.)
 *   0b. Layout-extract   → engine: "layout-extract"  (ONLY when heroImage exists,
 *      tried after composite fails — OpenAI vision extracts the reference's LAYOUT
 *      structure (tolerates celebrity refs), the block engine deterministically
 *      renders it with the REAL hero photo. No Gemini, no refusal, 100% reliable.)
 *   1. Gemini img2img    → engine: "gemini-img2img"
 *   2. OpenAI described  → engine: "openai-described"
 *   3. Template signal   → engine: "template", imageBase64: "" (caller falls back)
 *
 * In "overlay" textMode, after a successful rung-1 or rung-2, the headline and
 * logo are composited deterministically via deps.overlayHeadlineAndLogo. (The
 * composite rung renders text via Gemini in "ai" mode or composites the headline
 * via overlayHeadlineAndLogo in "overlay" mode — see generateCompositeStyledCard.)
 * The layout-extract rung always renders text deterministically via the block engine,
 * regardless of textMode — that is its primary reliability guarantee.
 */
export async function generateReferenceStyledCard(
  args: GenerateReferenceStyledCardArgs,
  deps: ReferenceCardDeps,
): Promise<GenerateReferenceStyledCardResult> {
  const { referenceImage, heroImage, logoImage, textMode } = args;

  // ── Rung 0: Layout-extract — the PRIMARY, RELIABLE, DETERMINISTIC path ───────
  // (Round 18) Promoted to FIRST for EVERY reference. OpenAI vision reads the
  // reference's LAYOUT (tolerates celebrity photos in the ref — it reads composition,
  // not identity), then the block engine renders it deterministically with the REAL
  // hero photo, honoring the reference's detected colors/scrim/alignment (hasReference)
  // and the user's controls (font/color/align/logo size). No Gemini, no refusal, no
  // fabricated faces, no broken magenta-sentinel cards — consistent + controllable for
  // ALL references. This is the engine that already produced the good Moviefied output.
  //
  // WHY it leads now (Round 18): the Gemini rungs below are a "rung roulette" — they
  // fire only for refs Gemini doesn't refuse, and the composite/sentinel path produced
  // broken output (mispasted photo + raw magenta blocks) for non-celebrity refs like
  // MAM. Making layout-extract primary removes that inconsistency. The Gemini rungs
  // remain ONLY as fallbacks if layout-extract itself can't render (rare — the
  // synthesized fallbackLayout makes it almost always succeed).
  //
  // Also runs when there is NO hero photo (mimicry intent via a reference or
  // styleOverride): it renders a clean PHOTOLESS branded card — NEVER the fake-AI-face
  // rungs below — which is the fix for NDTV-class URLs whose hero hard-403s server-side.
  {
    const layoutCard = await generateLayoutExtractCard(args, deps);
    if (layoutCard) return layoutCard;
    console.warn("[reference-card-generator] Layout-extract rung unavailable — advancing to Gemini fallbacks.");
  }

  // ── Rung 0b (FALLBACK): Gemini composite (hero only) ─────────────────────────
  // Only reached if layout-extract failed (very rare). Recreates the reference layout
  // via Gemini with a magenta sentinel photo region then pastes the REAL hero in. Kept
  // as a fallback; no longer the primary because its sentinel detection is fragile on
  // arbitrary reference layouts.
  if (heroImage) {
    const composite = await generateCompositeStyledCard(args, deps);
    if (composite) return composite;
    console.warn("[reference-card-generator] Gemini-composite fallback unavailable — advancing to rung 1.");
  }

  // Build the ordered referenceImages array: [ref, hero?, logo?] (compact — filter undefined).
  const referenceImages: Array<{ base64: string; mimeType?: string }> = [
    { base64: referenceImage.base64, mimeType: referenceImage.mimeType },
    ...(heroImage ? [{ base64: heroImage.base64, mimeType: heroImage.mimeType }] : []),
    ...(logoImage ? [{ base64: logoImage.base64, mimeType: logoImage.mimeType }] : []),
  ];

  const prompt = buildGeminiPrompt(args, !!heroImage);

  // ── Rung 1: Gemini img2img ──────────────────────────────────────────────────
  try {
    const raw = await deps.generateImage({ prompt, aspectRatio: "4:5", referenceImages });

    if (!raw.imageBase64) {
      throw new Error("Gemini returned empty imageBase64 — advancing to rung 2");
    }

    // In overlay mode, composite the headline/logo deterministically over the
    // Gemini-generated background so the text is always correct and legible.
    if (textMode === "overlay") {
      const composited = await deps.overlayHeadlineAndLogo(
        buildOverlayArgs(args, raw.imageBase64, raw.mimeType),
      );
      return { imageBase64: composited.imageBase64, mimeType: composited.mimeType, engine: "gemini-img2img" };
    }

    return { imageBase64: raw.imageBase64, mimeType: raw.mimeType, engine: "gemini-img2img" };
  } catch (err) {
    console.warn("[reference-card-generator] Rung-1 (Gemini img2img) failed:", (err as Error).message);
  }

  // ── Rung 2: OpenAI described ────────────────────────────────────────────────
  try {
    // Vision-describe the reference to build a style-aware text prompt.
    const descriptor = await deps.describeImageStyle(referenceImage.base64, referenceImage.mimeType);
    const openAIPrompt = buildOpenAIPrompt(args, descriptor);

    const raw = await deps.generateImageDallE({
      prompt: openAIPrompt,
      size: "1024x1536", // portrait; closest to 1080×1350
      quality: "high",
    });

    if (!raw.imageBase64) {
      throw new Error("OpenAI returned empty imageBase64 — advancing to rung 3");
    }

    if (textMode === "overlay") {
      const composited = await deps.overlayHeadlineAndLogo(
        buildOverlayArgs(args, raw.imageBase64, raw.mimeType),
      );
      return { imageBase64: composited.imageBase64, mimeType: composited.mimeType, engine: "openai-described" };
    }

    return { imageBase64: raw.imageBase64, mimeType: raw.mimeType, engine: "openai-described" };
  } catch (err) {
    console.warn("[reference-card-generator] Rung-2 (OpenAI described) failed:", (err as Error).message);
  }

  // ── Rung 3: Template signal ─────────────────────────────────────────────────
  //
  // Both rungs failed. Return engine: "template" with empty imageBase64 and
  // mimeType. The CALLER (Task 2 / router) interprets this as "fall back to the
  // existing renderStaticCreative / buildStaticCreative path." We intentionally
  // do NOT render a template here — that would duplicate code that already lives
  // in the router and creative-templates.ts.
  console.warn("[reference-card-generator] Both rungs failed — signalling template fallback.");
  return { imageBase64: "", mimeType: "", engine: "template" };
}

// ── Overlay helper ────────────────────────────────────────────────────────────

/**
 * Build the OverlayHeadlineArgs from GenerateReferenceStyledCardArgs +
 * the generated background.  Extracted so both rung-1 and rung-2 share it.
 */
function buildOverlayArgs(
  args: GenerateReferenceStyledCardArgs,
  imageBase64: string,
  mimeType: string,
): OverlayHeadlineArgs {
  return {
    imageBase64,
    mimeType,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    headline: args.headline,
    brandName: args.brandName,
    handle: args.handle,
    logoBase64: args.logoImage?.base64,
    logoMimeType: args.logoImage?.mimeType,
    brandColor: args.brandColor,
  };
}

// ── Puppeteer overlay primitive ───────────────────────────────────────────────

/**
 * Pure HTML builder for the overlay card. Exported so it can be unit-tested
 * without launching a real Puppeteer browser, mirroring how buildStaticCreative
 * is separated from generateStyledCreativeImage in creative-templates.ts.
 *
 * SECURITY contract (all user-controlled inputs sanitized before interpolation):
 *  - brandColor  → safeColor() (strict hex allow-list, rejects CSS-injection)
 *  - headline, brandName, handle → escapeHtml()
 *  - logoBase64 data URL → assembled then gated through safeImageUrl()
 *    (rejects any mimeType containing `"'()<>\` — prevents attribute breakout
 *    via a malicious Content-Type header)
 *  - logoUrl (public URL) → double-gated: isPublicImageUrl() (SSRF host check)
 *    AND safeImageUrl() (attribute-breakout char rejection). Both gates MUST be
 *    kept — safeImageUrl allows any https host so the SSRF gate cannot be removed.
 *  - background → trusted data: URL (we generated it); interpolated as-is.
 */
export function buildOverlayHtml(opts: OverlayHeadlineArgs): string {
  const {
    imageBase64,
    mimeType,
    width,
    height,
    headline,
    brandName,
    handle,
    logoUrl,
    logoBase64,
    logoMimeType,
    brandColor,
  } = opts;

  const safeAccent = safeColor(brandColor ?? undefined);
  const safeHeadline = escapeHtml(headline);
  const safeBrandName = brandName ? escapeHtml(brandName) : "";
  const safeHandle = handle ? escapeHtml(handle) : "";
  const bgDataUrl = `data:${mimeType};base64,${imageBase64}`;

  // ── Logo HTML ───────────────────────────────────────────────────────────────
  // Priority: inline base64 logo > SSRF-gated URL > monogram avatar.
  //
  // Fix 1: the assembled data URL is gated through safeImageUrl() — a malicious
  //   logoMimeType (e.g. `image/png" onerror="...`) contains a `"` which the
  //   regex rejects → safeImageUrl returns null → falls through to monogram.
  //   A normal base64 data URL (alphabet: A-Za-z0-9+/=) passes cleanly.
  //
  // Fix 2: logoUrl is double-gated: isPublicImageUrl() (SSRF host check) first,
  //   then safeImageUrl() (attribute-breakout char rejection). Both must pass.
  const inlineLogoUrl =
    logoBase64 && logoMimeType
      ? safeImageUrl(`data:${logoMimeType};base64,${logoBase64}`)
      : null;
  const publicLogoUrl =
    logoUrl && isPublicImageUrl(logoUrl) ? safeImageUrl(logoUrl) : null;

  let logoHtml: string;
  if (inlineLogoUrl) {
    logoHtml = `<img src="${inlineLogoUrl}" style="width:44px;height:44px;border-radius:10px;object-fit:cover;border:2px solid rgba(255,255,255,0.2);flex-shrink:0;" />`;
  } else if (publicLogoUrl) {
    logoHtml = `<img src="${publicLogoUrl}" style="width:44px;height:44px;border-radius:10px;object-fit:cover;border:2px solid rgba(255,255,255,0.2);flex-shrink:0;" crossorigin="anonymous" />`;
  } else {
    // Fallback: brand-colored monogram initial.
    const initial = escapeHtml((brandName?.[0] ?? "B").toUpperCase());
    logoHtml = `<div style="width:44px;height:44px;border-radius:10px;background:${safeAccent};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:18px;flex-shrink:0;">${initial}</div>`;
  }

  // ── Brand row (logo + name + handle) ────────────────────────────────────────
  const brandRowHtml = safeBrandName
    ? `<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
        ${logoHtml}
        <div>
          <div style="color:#fff;font-size:17px;font-weight:700;line-height:1.2;text-shadow:0 1px 4px rgba(0,0,0,0.6);">${safeBrandName}</div>
          ${safeHandle ? `<div style="color:rgba(255,255,255,0.7);font-size:13px;font-weight:400;text-shadow:0 1px 3px rgba(0,0,0,0.5);">${safeHandle}</div>` : ""}
        </div>
      </div>`
    : "";

  // ── Full HTML ────────────────────────────────────────────────────────────────
  // Inter via Google Fonts (same @import as overlayLogoOnImage).
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
*{margin:0;padding:0;box-sizing:border-box;}
body{width:${width}px;height:${height}px;overflow:hidden;position:relative;font-family:'Inter',system-ui,sans-serif;}
.bg{position:absolute;inset:0;background-image:url(${bgDataUrl});background-size:cover;background-position:center;}
.lower-band{
  position:absolute;bottom:0;left:0;right:0;
  padding:40px 48px 48px 48px;
  background:linear-gradient(0deg,rgba(0,0,0,0.82) 0%,rgba(0,0,0,0.55) 55%,transparent 100%);
}
.headline{
  color:#fff;
  font-size:clamp(32px,3.4vw,54px);
  font-weight:800;
  line-height:1.2;
  letter-spacing:-0.02em;
  text-shadow:0 2px 8px rgba(0,0,0,0.5);
  word-break:break-word;
}
.accent-bar{
  width:48px;height:5px;border-radius:3px;
  background:${safeAccent};
  margin-bottom:16px;
}
</style></head><body>
<div class="bg"></div>
<div class="lower-band">
  ${brandRowHtml}
  <div class="accent-bar"></div>
  <div class="headline">${safeHeadline}</div>
</div>
</body></html>`;
}

/**
 * Composite a headline + optional logo over a generated background image using
 * Puppeteer, mirroring the pattern in overlayLogoOnImage (news-image-generator.ts).
 *
 * Text placement: lower-third with a subtle scrim for legibility over any
 * background. This is the "always correct" path — it does not attempt to match
 * the reference's exact headline position (that's the "ai" textMode's job).
 *
 * HTML construction is delegated to buildOverlayHtml (pure, testable).
 */
export async function overlayHeadlineAndLogo(
  opts: OverlayHeadlineArgs,
  sharedBrowser?: import("puppeteer").Browser,
): Promise<{ imageBase64: string; mimeType: string }> {
  const { mimeType, width, height, browser: optsBrowser } = opts;

  // Resolve browser: opts.browser > sharedBrowser (legacy arg) > self-launch
  const resolvedSharedBrowser = optsBrowser ?? sharedBrowser;

  const html = buildOverlayHtml(opts);

  const browser = resolvedSharedBrowser ?? (await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  }));

  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height });
    // Use `load` (NOT `networkidle0`): the bg is an inline data-URL and the only
    // network request is the Google-Fonts @import, so `networkidle0` never settles.
    // If `load` also times out, fall back to domcontentloaded and capture whatever
    // state is available (mirrors overlayLogoOnImage / generateStyledCreativeImage).
    try {
      await page.setContent(html, { waitUntil: "load", timeout: 30000 });
    } catch (e) {
      console.warn(`[headline-overlay] setContent timed out, screenshotting:`, (e as Error).message);
      await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => {});
    }
    // Paint delay: give the bg image + font a moment to render.
    await new Promise((r) => setTimeout(r, 400));

    const screenshotBuffer = await page.screenshot({
      type: mimeType.includes("png") ? "png" : "jpeg",
      quality: mimeType.includes("png") ? undefined : 85,
      encoding: "base64",
    });

    return { imageBase64: screenshotBuffer as string, mimeType };
  } finally {
    await page.close().catch(() => {});
    if (!resolvedSharedBrowser) await browser.close();
  }
}

// ── Composite Puppeteer primitives ─────────────────────────────────────────────

/**
 * Resolve the hero photo source (a string for an <img src>) from CompositeHeroArgs,
 * applying the same sanitization posture as buildOverlayHtml:
 *  - heroBase64 + heroMimeType → assembled data: URL, gated through safeImageUrl()
 *    (a malicious mimeType with `"'()<>\` is rejected).
 *  - heroUrl → double-gated: isPublicImageUrl() (SSRF host check) AND safeImageUrl()
 *    (attribute-breakout char rejection). Both must pass.
 * Returns null when no safe source is available (caller bails — no bogus paste).
 *
 * Exported for unit-testing the gate without launching a browser.
 */
export function resolveHeroSrc(opts: CompositeHeroArgs): string | null {
  if (opts.heroBase64 && opts.heroMimeType) {
    return safeImageUrl(`data:${opts.heroMimeType};base64,${opts.heroBase64}`);
  }
  if (opts.heroUrl && isPublicImageUrl(opts.heroUrl)) {
    return safeImageUrl(opts.heroUrl);
  }
  return null;
}

/**
 * Pure HTML builder for the composite card: the Gemini base layer with the hero
 * photo absolutely-positioned over the detected sentinel rectangle (object-fit:
 * cover, clipped to the box) so the real face covers the magenta. Exported for
 * unit-testing without a browser.
 *
 * SECURITY: the base is a trusted data: URL we generated. The hero src is gated
 * via resolveHeroSrc (safeImageUrl + SSRF). region numbers are coerced to finite
 * integers before interpolation (defence-in-depth; they originate from our own
 * pixel scan, not user input).
 */
export function buildCompositeHtml(opts: CompositeHeroArgs, heroSrc: string): string {
  const { baseImageBase64, baseMimeType, region, width, height } = opts;
  const baseDataUrl = `data:${baseMimeType};base64,${baseImageBase64}`;

  // Coerce region to finite ints and clamp to the card bounds (defence-in-depth).
  const num = (v: number, fallback: number) => (Number.isFinite(v) ? Math.round(v) : fallback);
  const rx = Math.max(0, num(region.x, 0));
  const ry = Math.max(0, num(region.y, 0));
  const rw = Math.max(1, Math.min(width - rx, num(region.w, width)));
  const rh = Math.max(1, Math.min(height - ry, num(region.h, height)));

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box;}
body{width:${width}px;height:${height}px;overflow:hidden;position:relative;}
.base{position:absolute;inset:0;width:${width}px;height:${height}px;object-fit:cover;}
.hero{position:absolute;left:${rx}px;top:${ry}px;width:${rw}px;height:${rh}px;object-fit:cover;overflow:hidden;}
</style></head><body>
<img class="base" src="${baseDataUrl}" />
<img class="hero" src="${heroSrc}" crossorigin="anonymous" />
</body></html>`;
}

/**
 * Detect the magenta SENTINEL rectangle in a Gemini-generated base card.
 *
 * Loads the PNG into an offscreen <canvas> in a Puppeteer page, reads its pixels
 * via getImageData, and delegates the scan to findSentinelBBox (pure). Returns the
 * bbox in image coordinates, or null when no sufficiently-large magenta region is
 * found (Gemini ignored the sentinel instruction → caller advances a rung).
 *
 * The pixel scan runs IN the browser (page.evaluate) because findSentinelBBox is
 * inlined there — Node has no DOM canvas. The thresholds + min-area + stride are
 * passed in so the in-browser copy stays in lockstep with the exported pure fn.
 */
export async function detectSentinelRegion(
  params: { imageBase64: string; mimeType: string },
  sharedBrowser?: import("puppeteer").Browser,
): Promise<SentinelBBox | null> {
  const { imageBase64, mimeType } = params;
  if (!imageBase64) return null;
  const dataUrl = `data:${mimeType};base64,${imageBase64}`;

  const browser =
    sharedBrowser ??
    (await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    }));

  const page = await browser.newPage();
  try {
    // Read the image dimensions + RGBA bytes in the browser; do the bbox scan in
    // Node via findSentinelBBox so the trusted pure function is the single source.
    const pixels = await page.evaluate(async (src: string) => {
      // @ts-ignore - Image is available in browser context
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("image load failed"));
        img.src = src;
      });
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      // @ts-ignore - document is available in browser context
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, w, h);
      // Transfer as a plain array (structured-clone-safe across the bridge).
      return { width: w, height: h, data: Array.from(data) as number[] };
    }, dataUrl);

    const bbox = findSentinelBBox(
      Uint8ClampedArray.from(pixels.data),
      pixels.width,
      pixels.height,
    );
    return bbox;
  } catch (err) {
    console.warn("[reference-card-generator] detectSentinelRegion failed:", (err as Error).message);
    return null;
  } finally {
    await page.close().catch(() => {});
    if (!sharedBrowser) await browser.close();
  }
}

/**
 * Paste the user's REAL hero photo into the detected sentinel region of the Gemini
 * base card via Puppeteer, mirroring overlayHeadlineAndLogo's browser lifecycle.
 * The hero's face is pixel-real — NEVER touched by any AI model.
 *
 * HTML construction is delegated to buildCompositeHtml (pure, testable); the hero
 * source is sanitized via resolveHeroSrc. If no safe hero source resolves, returns
 * an empty image so the caller (generateCompositeStyledCard) bails out cleanly.
 */
export async function compositeHeroIntoRegion(
  opts: CompositeHeroArgs,
  sharedBrowser?: import("puppeteer").Browser,
): Promise<{ imageBase64: string; mimeType: string }> {
  const resolvedSharedBrowser = opts.browser ?? sharedBrowser;
  const mimeType = opts.baseMimeType;

  const heroSrc = resolveHeroSrc(opts);
  if (!heroSrc) {
    console.warn("[reference-card-generator] compositeHeroIntoRegion: no safe hero source.");
    return { imageBase64: "", mimeType: "" };
  }

  const html = buildCompositeHtml(opts, heroSrc);

  const browser =
    resolvedSharedBrowser ??
    (await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    }));

  const page = await browser.newPage();
  try {
    await page.setViewport({ width: opts.width, height: opts.height });
    // Both <img>s are inline data: URLs (base is a data URL; hero is a data URL or
    // a public https URL). `load` waits for them; if it times out, screenshot what
    // rendered (mirrors overlayHeadlineAndLogo).
    try {
      await page.setContent(html, { waitUntil: "load", timeout: 30000 });
    } catch (e) {
      console.warn(`[composite-hero] setContent timed out, screenshotting:`, (e as Error).message);
      await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 400));

    const screenshotBuffer = await page.screenshot({
      type: mimeType.includes("png") ? "png" : "jpeg",
      quality: mimeType.includes("png") ? undefined : 85,
      encoding: "base64",
    });

    return { imageBase64: screenshotBuffer as string, mimeType };
  } finally {
    await page.close().catch(() => {});
    if (!resolvedSharedBrowser) await browser.close();
  }
}
