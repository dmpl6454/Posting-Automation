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
 * THE THREE-RUNG LADDER
 * ─────────────────────
 * 1. Gemini img2img  — feeds referenceImage (+ hero, logo) to deps.generateImage.
 *    Returns engine: "gemini-img2img". MOST FAITHFUL.
 * 2. OpenAI described — on rung-1 failure: vision-describe the reference via
 *    deps.describeImageStyle, build a text-to-image prompt, call deps.generateImageDallE.
 *    Returns engine: "openai-described". APPROXIMATION.
 * 3. Template fallback — both rungs failed: returns engine: "template" with
 *    imageBase64: "" and mimeType: "". The CALLER interprets "template" as
 *    "fall back to the existing renderStaticCreative/buildStaticCreative path."
 *    This module does NOT re-implement any template renderer.
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
import { safeColor, escapeHtml, safeImageUrl } from "./card-engine";
import { isPublicImageUrl } from "../utils/safe-fetch-url";

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
}

export type ReferenceCardEngine = "gemini-img2img" | "openai-described" | "template";

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

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Generate a 1080×1350 social card that recreates the reference image's LAYOUT.
 *
 * Attempts three rungs in order:
 *   1. Gemini img2img   → engine: "gemini-img2img"
 *   2. OpenAI described → engine: "openai-described"
 *   3. Template signal  → engine: "template", imageBase64: "" (caller falls back)
 *
 * In "overlay" textMode, after a successful rung-1 or rung-2, the headline and
 * logo are composited deterministically via deps.overlayHeadlineAndLogo.
 */
export async function generateReferenceStyledCard(
  args: GenerateReferenceStyledCardArgs,
  deps: ReferenceCardDeps,
): Promise<GenerateReferenceStyledCardResult> {
  const { referenceImage, heroImage, logoImage, textMode } = args;

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
