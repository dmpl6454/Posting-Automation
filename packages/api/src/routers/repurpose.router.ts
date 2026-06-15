import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure, orgProcedure } from "../trpc";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import {
  pushProgress,
  finishProgress,
  scopedProgressId,
  repurposeVideoQueue,
  type RepurposeVideoJobData,
} from "@postautomation/queue";
import { toFriendlyAIError, isMissingAIKeyError, friendlyAIMessage } from "../lib/ai-errors";
import { requirePlan, enforcePlanLimit } from "../middleware/plan-limit.middleware";

// S3 helpers
function getS3Client(): S3Client {
  return new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || "",
    },
  });
}
const BUCKET = process.env.S3_BUCKET || "postautomation-media";
function getPublicUrl(key: string): string {
  if (process.env.S3_PUBLIC_URL) return `${process.env.S3_PUBLIC_URL}/${key}`;
  return `${process.env.S3_ENDPOINT || "https://s3.amazonaws.com"}/${BUCKET}/${key}`;
}

/**
 * Drop failed (undefined/null) slides from a sparse slide-image array before
 * passing them to the reel stitcher. `slideImages` is indexed by slide position,
 * so a slide whose generation failed leaves a hole — mapping over it directly
 * would crash on `undefined.imageBase64`. Pure + exported for unit testing.
 */
export function compactSlides<T>(slideImages: (T | undefined | null)[]): T[] {
  return slideImages.filter((s): s is T => Boolean(s));
}

/**
 * Whether a creative style needs an AI-generated photo background.
 *
 * ALL styles now get an AI background (product decision 2026-06-11): users
 * expected `hook_bars` ("Hook + Headline") and `bold_typographic` to render rich
 * AI imagery like `premium_editorial`/`tweet_card`, not sit on a flat near-white
 * fill — which read as "blank", and made carousel body/cta slides blank too.
 * The hook/headline/body text simply layers on top of the AI photo (the
 * templates already scrim + render the text bars over `.bg`). CTA slides remain
 * the one exception (handled by the `slideRole !== "cta"` guard at the call
 * site) — they're a centered "Follow for more" card on a branded gradient.
 * `false` is dead today but kept so the signature/tests stay meaningful.
 * Pure + exported for unit testing.
 */
export function styleNeedsAiBackground(_style: string): boolean {
  return true;
}

/**
 * Pick the article's own photo (og:image, first in `extracted.images`) to use as
 * the static-creative BACKGROUND. The locked product decision: hook+headline
 * styles should sit on the real article photo (the templates render a
 * scrim/branded gradient fallback when none is supplied). For AI-background
 * styles (premium_editorial / tweet_card) this becomes the harmless DEFAULT that
 * the AI overrides — and the AI-failure catch falls back to it.
 *
 * https-only: the downstream `safeImageUrl` in creative-templates accepts only
 * `https://` or `data:image` (NOT `http://`), so an http og:image would be
 * silently dropped there anyway. `isAllowed` is the `isPublicImageUrl` SSRF gate.
 * Pure + exported for unit testing.
 */
/**
 * Is `url` a real RASTER content photo (not a tracking pixel, analytics beacon,
 * or vector/logo SVG)? CONTENT-QUALITY filter — NOT a security boundary; the
 * SSRF gate remains `isAllowed` (isPublicImageUrl).
 *
 * `pickArticleBgImage` picks the HERO (og:image/first image), so this mirrors
 * url-extractor's HERO filter (`isLikelyOgPhoto`): bad-extension + tracker ONLY,
 * NO chrome-keyword (`icon`/`logo`) filter. A loose keyword match was the T5
 * regression — it dropped legit heroes like `silicon-valley.jpg` and the real
 * publishers `analyticsindiamag.com` / `analyticsinsight.net`. Tracker tokens
 * are SPECIFIC (multi-part substrings) plus `analytics` as a full host LABEL.
 * Replicated here (defense in depth, cross-package) — keep IDENTICAL to the
 * url-extractor hero rules. Pure / no network; malformed urls → false.
 * Exported for unit testing.
 */
export function isRasterPhotoUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const lowerUrl = url.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  // Rule 1: bad non-photo extensions (path only — ignore ?query).
  const BAD_EXTENSIONS = [".svg", ".gif", ".ico", ".bmp"];
  if (BAD_EXTENSIONS.some((ext) => path.endsWith(ext))) return false;

  // Rule 2: tracker tokens (unambiguous multi-part substrings against host+url)
  // + `analytics` as a full host LABEL only (NOT a substring — spares
  // analyticsindiamag.com / img.analyticsinsight.net). `/pixel` and `/beacon`
  // are intentionally absent (they dropped "Pixel 7" / "Beacon Hill" stories).
  const TRACKER_TOKENS = [
    "scorecardresearch",
    "doubleclick",
    "google-analytics",
    "googletagmanager",
    "googlesyndication",
    "facebook.com/tr",
    "quantserve",
    "chartbeat",
  ];
  if (TRACKER_TOKENS.some((s) => host.includes(s) || lowerUrl.includes(s))) {
    return false;
  }
  if (host.split(".").includes("analytics")) return false;

  return true;
}

export function pickArticleBgImage(
  images: string[] | undefined,
  isAllowed: (u: string) => boolean,
): string | undefined {
  if (!images) return undefined;
  for (const u of images) {
    if (
      typeof u === "string" &&
      u.startsWith("https://") &&
      isAllowed(u) &&
      isRasterPhotoUrl(u)
    ) {
      return u;
    }
  }
  return undefined;
}

/**
 * A user image assigned to a specific image slot (D10). `slot` is a stable key:
 *   "background" | "inset:N" | "subject" | "grid:N" | "slide:N"
 * `mediaId` is an org-owned Media id. Multiple assignments allowed; each is
 * resolved independently by `resolveImageSlot`.
 */
export type SlotAssignment = { slot: string; mediaId: string };

/**
 * Build the `userImages` lookup (media id → { url }) consumed by `resolveImageSlot`,
 * keeping ONLY assignments whose mediaId resolved to an org-owned Media row.
 * `ownedRows` MUST already be org-scoped by the caller (assertMediaOwned). Pure +
 * exported for unit testing.
 */
export function resolveSlotAssignments(
  assignments: SlotAssignment[],
  ownedRows: Array<{ id: string; url: string }>,
): Record<string, { url: string }> {
  const byId = new Map(ownedRows.map((r) => [r.id, r.url]));
  const out: Record<string, { url: string }> = {};
  for (const a of assignments) {
    const url = byId.get(a.mediaId);
    if (url) out[a.mediaId] = { url };
  }
  return out;
}

const PRESET_TITLES: Record<string, string> = {
  news_caption: "News Caption",
  news_inset: "News Inset",
  infographic_stats: "Infographic Stats",
  marketing_minimal: "Marketing Minimal",
  tweet_card: "Tweet Card",
  photo_grid: "Photo Grid",
  title_cover: "Title Cover",
  listicle_body: "Listicle Body",
};

/** Auto-name a saved style from its detected preset + date. Pure + exported. */
export function buildSavedStyleName(preset: string | undefined, now: Date): string {
  const title = (preset && PRESET_TITLES[preset]) || "Saved style";
  return `${title} — ${now.toISOString().slice(0, 10)}`;
}

/**
 * Persist a reference as a CreativeTemplate ONLY when we both stored the source
 * image (have a media id) AND classified it with reasonable confidence (≥0.5). A
 * low-confidence / failed classification is NOT auto-saved (avoids junk in the
 * gallery). Pure + exported for unit testing.
 */
export function shouldPersistReference(
  referenceMediaId: string | undefined,
  hint: { confidence: number } | null,
): boolean {
  return Boolean(referenceMediaId) && Boolean(hint) && hint!.confidence >= 0.5;
}

/**
 * Map a detected reference PRESET (classifyCard's 8 layout ids) to the closest of
 * the 4 renderable creative styles, so an uploaded reference actually DRIVES the
 * rendered template — not merely a saved-style name. Pure + exported for testing.
 *   tweet_card                          → tweet_card        (tweet screenshot)
 *   news_inset                          → hook_bars         (headline bar + inset)
 *   marketing_minimal, infographic_stats→ bold_typographic  (type-forward)
 *   everything else                     → premium_editorial (photo + bottom headline)
 */
export function presetToCreativeStyle(preset: string): string {
  switch (preset) {
    case "tweet_card":
      return "tweet_card";
    case "news_inset":
      return "hook_bars";
    case "marketing_minimal":
    case "infographic_stats":
      return "bold_typographic";
    default:
      return "premium_editorial";
  }
}

/**
 * A photo-led reference layout — built around a real photo — so a repurpose using
 * it should prefer the article's OWN photo over an invented AI background (E).
 * Pure + exported for testing.
 */
export function isPhotoCardPreset(preset: string): boolean {
  return (
    preset === "news_caption" ||
    preset === "title_cover" ||
    preset === "photo_grid" ||
    preset === "news_inset"
  );
}

/**
 * Camera/composition angles cycled across carousel slides so each AI background
 * looks visually DISTINCT instead of "same person, same scene" on every slide.
 * Indexed modulo the list so any slide count is covered.
 */
const SLIDE_ANGLES = [
  "wide establishing shot",
  "close-up detail / texture",
  "overhead flat-lay composition",
  "abstract geometric pattern",
  "environment / location shot",
] as const;

/** Pick the camera/composition angle for slide N (wraps around). Pure + exported. */
export function slideAngleDescriptor(slideIdx: number): string {
  return SLIDE_ANGLES[slideIdx % SLIDE_ANGLES.length]!;
}

/**
 * Build a PER-SLIDE carousel AI-background prompt that varies by slide (R3). The
 * old code appended the FULL shared `contentBrief` (incl. `SUBJECT: <full named
 * person>` + a single `VISUAL:`) to every slide with only a 3–6-word title
 * varying — so every slide's prompt was ~95% identical and rendered the same
 * person/scene. This builder instead:
 *   - cycles a distinct camera/composition `angle` per slide,
 *   - uses the slide's OWN title + body (the per-slide content), and
 *   - includes ONLY the CATEGORY/TONE lines from the brief (`categoryTone`),
 *     dropping the repeated SUBJECT/VISUAL that caused the sameness,
 *   - explicitly asks the model to make each scene DISTINCT.
 * The result still flows through the caller's `append` (= `appendImageContext`)
 * so the user's style notes reach `sanitizePrompt` inside `generateImageSafe`.
 * Pure + exported for unit testing.
 */
export function buildCarouselSlidePrompt(
  opts: {
    slideTitle: string;
    slideBody?: string;
    slideIdx: number;
    totalSlides: number;
    categoryTone: string;
    imageContext?: string;
  },
  append: (base: string, ctx?: string) => string,
): string {
  const angle = slideAngleDescriptor(opts.slideIdx);
  const base =
    `Cinematic background photo, ${angle}, visually depicting: "${opts.slideTitle}".` +
    (opts.slideBody ? ` ${opts.slideBody}` : "") +
    ` ${opts.categoryTone}` +
    ` Slide ${opts.slideIdx + 1} of ${opts.totalSlides}. Make this scene visually DISTINCT from the other slides.`;
  return append(base, opts.imageContext);
}

/**
 * Unconditional real-person guard appended to EVERY static-creative AI-background
 * prompt (R3). Mirrors the clause in `seedance.provider.ts`. MUST be on the
 * prompt unconditionally because the prod image path bypasses `sanitizePrompt`'s
 * safety-only guard (the Gemini billing-403 doesn't match `isSafetyBlock`, so a
 * raw prompt carrying a real named subject goes straight to gpt-image-1, which
 * then renders that real person). Exported for unit testing.
 */
export const NO_REAL_PERSON_CLAUSE =
  " Do NOT depict any specific, real, named public figure or recognizable real person; use only anonymous, generic, non-identifiable people.";

/**
 * Cap a punchy hook line to ≤7 words and ≤60 visible characters WHILE
 * preserving any `**...**` emphasis markup. A naive substring/word cut could
 * split a `**word**` pair and leave a dangling `**`; this drops any trailing
 * unbalanced marker cleanly so the downstream `renderHighlightMarkup` never
 * sees a half-open span. Pure + exported for unit testing.
 */
export function capHookLine(raw: string): string {
  let out = raw.trim().split(/\s+/).filter(Boolean).slice(0, 7).join(" ");
  if (out.length > 60) {
    out = out.slice(0, 60).replace(/\s+\S*$/, "").trim();
  }
  // Drop a dangling (odd) `**` marker so highlight spans stay balanced.
  const markers = out.match(/\*\*/g) || [];
  if (markers.length % 2 === 1) {
    const lastIdx = out.lastIndexOf("**");
    out = (out.slice(0, lastIdx) + out.slice(lastIdx + 2)).trim();
  }
  return out.trim();
}

/**
 * Build the hook-line generation prompt for the `hook_bars` style. When the
 * user supplied free-text creative notes (the UI's "Aesthetic / style notes"),
 * they are passed through as WORDING instructions — e.g. "mention Doordarshan
 * in the hook" — so text directives in the notes actually reach the hook, not
 * just the background-image prompt. Color/layout directives are explicitly
 * told to be ignored here (they belong to the template/brand color, which the
 * AI cannot change). Pure + exported for unit testing.
 */
export function buildHookLinePrompt(headline: string, creativeNotes?: string): string {
  const notesClause = creativeNotes?.trim()
    ? `\nUser instructions — follow the parts about the hook's wording or which words to emphasize; ignore parts about colors, layout, or imagery: ${creativeNotes.trim()}`
    : "";
  return `Write a 4-7 word punchy hook for a social post about: ${headline}. Wrap ONE or TWO key words in **double asterisks** for emphasis.${notesClause}\nOutput ONLY the hook line, no quotes.`;
}

/**
 * Build the notes-aware headline rewrite prompt. Runs ONLY when the user
 * supplied creative notes: gives the AI one chance to honour wording
 * instructions (e.g. "mention Doordarshan") grounded in the article context,
 * while ignoring purely visual instructions. Instructed to return the headline
 * unchanged when no wording instruction applies, so visual-only notes are a
 * no-op for the text. Pure + exported for unit testing.
 */
export function buildHeadlineRewritePrompt(
  headline: string,
  context: string,
  creativeNotes: string,
): string {
  return `You are refining the headline baked onto a social-post image.

Current headline: ${headline}
Article context: ${context}
User instructions: ${creativeNotes}

Apply ONLY the instructions that concern wording or what/who to mention. Ignore instructions about colors, fonts, layout, or imagery. If no wording instruction applies, return the current headline UNCHANGED. Return ONLY the headline text — one complete headline, max 14 words, no trailing fragments, no quotes, no hashtags, no emojis.`;
}

/**
 * Derive the BEST headline for a carousel cover (or any format that needs a
 * readable visual headline) from the raw extraction result + AI content brief.
 * Mirrors the same 3-step logic the STATIC branch uses:
 *   1. Generic-title detection → swap in the AI SUBJECT from the content brief.
 *   2. Social-post synthesis   → synthesize a clean headline from the caption.
 *   3. Notes-aware rewrite     → honour wording instructions from imageContext.
 *
 * Called server-side inside the mutation so `generateContentResilient` is
 * passed in as a parameter (keeps the function testable and avoids a circular
 * import). All three steps degrade gracefully — failures return the previous
 * best value. Pure enough to unit-test the branch logic; exported for tests.
 */
export async function deriveCreativeHeadline({
  extracted,
  contentBrief,
  contentSummary,
  creativeNotes,
  generateFn,
}: {
  extracted: { title: string; description?: string; body: string; type: string };
  contentBrief: string;
  contentSummary: string;
  creativeNotes: string;
  generateFn: (prompt: string) => Promise<string>;
}): Promise<string> {
  // Step 1: prefer the AI SUBJECT over a generic site/listing <title>
  const briefSubject = /SUBJECT:\s*([^\n]+)/i.exec(contentBrief)?.[1]?.trim() || "";
  const looksGenericTitle =
    /\|\s*\w|breaking news|top headlines|latest news|home\s*[-|]|homepage/i.test(extracted.title) ||
    extracted.title.length > 90;
  let headline =
    looksGenericTitle && briefSubject && briefSubject.length > 3
      ? briefSubject.replace(/\s*[-–—,]\s*(bollywood actor|politician|.*)$/i, "").trim() || briefSubject
      : extracted.title;

  // Step 2: social-post caption synthesis
  if (extracted.type === "social") {
    try {
      const synth = await generateFn(
        `Write ONE complete, self-contained, punchy news-style headline (max 14 words, no hashtags, no emojis) summarizing this social post. Return ONLY the headline text.\n\nPost: ${(extracted.body || extracted.description || extracted.title).slice(0, 800)}`,
      );
      const cleaned = synth.replace(/^["']|["']$/g, "").replace(/\n[\s\S]*$/, "").trim();
      if (cleaned.length > 3) headline = cleaned;
    } catch {
      // degrade to step-1 result
    }
  }

  // Step 3: notes-aware rewrite (wording instructions only)
  if (creativeNotes) {
    try {
      const rewritten = await generateFn(
        buildHeadlineRewritePrompt(headline, contentSummary.slice(0, 500), creativeNotes),
      );
      const cleaned = rewritten.replace(/^["']|["']$/g, "").replace(/\n[\s\S]*$/, "").trim();
      if (cleaned.length > 3) headline = cleaned;
    } catch {
      // degrade to step-2 result
    }
  }

  return capHeadline(headline);
}

/**
 * Cap a headline so it fits the creative template's largest comfortable size
 * tier WITHOUT ever ending mid-word. The template's headlineFontSize() renders
 * up to 16 words at 46px (creative-templates.ts:138), so 16 words / ~90 chars
 * is the real layout ceiling — not the old 12/80 guess.
 *
 * Strategy when over budget: keep whole words only; if we had to drop any
 * content, prefer cutting back to the last sentence-ending punctuation within
 * budget so the headline reads as a complete thought; otherwise append "…" so
 * it reads as deliberately abbreviated, never as a broken sentence.
 */
export function capHeadline(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  const words = cleaned.split(" ");
  const MAX_WORDS = 16;
  const MAX_CHARS = 90;

  // Measure the VISIBLE length (excluding **/== emphasis markers) so a headline
  // with brand-highlight markup isn't truncated just for the marker characters.
  // renderHighlightMarkup strips any orphan marker a later truncation might leave.
  const visible = cleaned.replace(/\*\*|==/g, "");
  if (words.length <= MAX_WORDS && visible.length <= MAX_CHARS) return cleaned;

  let out = words.slice(0, MAX_WORDS).join(" ");
  while (out.length > MAX_CHARS && out.includes(" ")) {
    out = out.slice(0, out.lastIndexOf(" "));
  }

  const lastStop = Math.max(out.lastIndexOf(". "), out.lastIndexOf("? "), out.lastIndexOf("! "));
  if (lastStop > out.length * 0.6) {
    return out.slice(0, lastStop + 1).trim();
  }

  return out.replace(/[\s,;:–—-]+$/, "").trim() + "…";
}

/**
 * Cut body text to maxChars on a whole-word boundary and append "…" when
 * content is dropped. Used for carousel slide/cover body fields where a raw
 * .slice() could chop mid-word. Pure + exported for unit testing.
 */
export function capBody(text: string, maxChars: number): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (cleaned.length <= maxChars) return cleaned;
  let out = cleaned.slice(0, maxChars);
  if (out.includes(" ")) out = out.slice(0, out.lastIndexOf(" "));
  return out.replace(/[\s,;:–—-]+$/, "").trim() + "…";
}

/**
 * Force the AI-extracted carousel content slides to EXACTLY `target` items so the
 * user's chosen "Content slides" count is honoured regardless of how many points
 * the model actually returned (E2). Strategy: slice if too long; if too short,
 * top up from `fallback` (the sentence-derived slides) in order, then pad with
 * generic `{ title: "Key point N", body: "" }` fillers until length === target.
 * Always returns exactly `target` items — never more, never fewer. Pure + exported
 * for unit testing. Does NOT touch the cover/cta slides added around the content.
 */
export function enforceSlideCount(
  slideData: Array<{ title: string; body: string }>,
  target: number,
  fallback: Array<{ title: string; body: string }>,
): Array<{ title: string; body: string }> {
  if (slideData.length >= target) {
    return slideData.slice(0, target);
  }
  const out = [...slideData];
  for (const f of fallback) {
    if (out.length >= target) break;
    out.push(f);
  }
  while (out.length < target) {
    out.push({ title: `Key point ${out.length + 1}`, body: "" });
  }
  return out;
}

/** Carousel slideCount is the TOTAL slide count (cover + content + CTA). Content slides = total - 2 (min 1). */
export function contentSlidesForTotal(total: number): number {
  return Math.max(1, total - 2);
}

/**
 * Append a free-text "aesthetic / style notes" clause to an AI background
 * prompt (E3a). If `imageContext` is empty/whitespace/undefined the base prompt
 * is returned UNCHANGED so the existing flow is untouched when the feature is
 * unused. The notes are trimmed and hard-capped at 300 chars (the router schema
 * also bounds it, but cap here defensively). The combined string still flows
 * through `sanitizePrompt` inside `generateImageSafe`, so no extra sanitizing is
 * needed here. Pure + exported for unit testing.
 */
export function appendImageContext(basePrompt: string, imageContext?: string): string {
  const notes = (imageContext ?? "").trim();
  if (notes.length === 0) return basePrompt;
  return `${basePrompt}\n\nStyle notes: ${notes.slice(0, 300)}`;
}

/**
 * Fold the OpenAI vision-derived aesthetic STYLE descriptor into the same
 * `imageContext` channel that already flows to the AI background prompt. This is
 * what makes the aesthetic-reference feature work provider-agnostically: the
 * descriptor reaches gpt-image-1 (which ignores `referenceImages`) via the text
 * prompt, while the raw reference is ALSO still pushed into `referenceImages` so
 * Gemini conditioning resumes once its billing hold lifts.
 *
 * Returns the user's `imageContext` and `styleDescriptor` joined with ". ",
 * dropping empties; `undefined` when both are empty so `appendImageContext`
 * leaves the base prompt untouched. Pure + exported for unit testing.
 */
export function mergeStyleContext(
  imageContext?: string,
  styleDescriptor?: string,
): string | undefined {
  return [imageContext, styleDescriptor].filter(Boolean).join(". ") || undefined;
}

/**
 * Render a single branded "static creative" (the static-post / carousel-cover
 * image) — extracted to module level (E3b) so BOTH the repurpose flow's
 * `buildHeadlineCreative` closure AND the standalone `regenerateImage` mutation
 * render through ONE code path (no duplicated render logic, identical output).
 *
 * Flow: generate an AI background photo for every style (only `cta` slides skip
 * it — they're a branded-gradient "Follow for more" card), then bake the
 * headline + logo + brand color onto it via the Puppeteer creative template
 * (`generateStyledCreativeImage`). If the AI background fails the template still
 * renders with the passed-in article photo / branded gradient, so a creative is
 * ALWAYS produced. Pure-ish: all I/O is via the injected AI helpers; no
 * router/ctx coupling.
 *
 * `bgPrompt` is expected to ALREADY have had `appendImageContext` applied by the
 * caller (so the user's style notes flow through `sanitizePrompt` inside
 * `generateImageSafe`). `referenceImages` (logo + aesthetic ref) are passed
 * through verbatim — callers are responsible for the `isPublicImageUrl` SSRF
 * gate before fetching/assembling them.
 */
export async function renderStaticCreative(args: {
  ai: {
    generateImageSafe: (a: any) => Promise<{ imageBase64: string; mimeType: string; source?: string }>;
    generateStyledCreativeImage: (a: any) => Promise<{ imageBase64: string; mimeType: string }>;
  };
  bgPrompt: string;
  headline: string;
  category: string;
  creativeStyle: string;
  theme: "dark" | "light" | "gradient";
  channelName: string;
  handle?: string;
  logoUrl?: string | null;
  logoPosition: "top-left" | "top-right";
  brandColor?: string | null;
  referenceImages?: Array<{ base64: string; mimeType?: string }>;
  hookLine?: string;
  slideRole?: "cover" | "body" | "cta";
  body?: string;
  /**
   * A pre-existing photo (e.g. the real article image) to use as the creative
   * background. Used as the DEFAULT bg; the AI-generation block below overrides
   * it only for styles that need an AI photo (premium_editorial / tweet_card),
   * and on AI failure we fall back to this passed-in photo.
   */
  bgImageUrl?: string;
  /**
   * D2 Real⇄AI switch. When `false`, the internal AI-background generation is
   * SKIPPED entirely and the passed-in `bgImageUrl` (real photo / branded
   * gradient) is used as-is — the renderer only bakes the headline/logo overlay.
   * Defaults to `true` (the prior always-AI behaviour); the repurpose flow passes
   * `false` because the per-slot ladder (`resolveImageSlot`) already owns the AI
   * rung, so generating again here would double-render (and double-bill).
   */
  aiEnabled?: boolean;
  browser?: unknown;
}): Promise<{ imageBase64: string; mimeType: string; bgSource: "ai" | "stock"; imageEngine?: "gemini" | "openai" }> {
  const { generateImageSafe, generateStyledCreativeImage } = args.ai;
  let backgroundImageUrl: string | undefined = args.bgImageUrl;
  let bgSource: "ai" | "stock" = "stock";
  // Coarse engine that actually produced the AI background (for honest UI
  // labeling): the gemini-* sanitized/generic variants all collapse to "gemini".
  let imageEngine: "gemini" | "openai" | undefined;
  const referenceImages = args.referenceImages ?? [];

  // Every style now gets an AI photo background (product decision 2026-06-11) —
  // hook_bars/bold_typographic layer their text bars on top, exactly like
  // premium_editorial. Only `cta` slides skip AI (they're a centered
  // "Follow for more" card on a branded gradient). On AI failure we fall back to
  // the passed-in real article photo (if any), never to a blank fill.
  if (args.aiEnabled !== false && args.slideRole !== "cta" && styleNeedsAiBackground(args.creativeStyle)) {
    const themeBgDescriptor =
      args.theme === "light"
        ? "bright, airy, well-lit, clean"
        : args.theme === "gradient"
          ? "vibrant, colorful, dramatic lighting"
          : "dark, moody, dramatic";
    try {
      const bg = await generateImageSafe({
        // NO_REAL_PERSON_CLAUSE is UNCONDITIONAL (always on the prompt): the prod
        // image path bypasses sanitizePrompt's safety-only guard, so this is the
        // only thing stopping a real named subject from being rendered.
        prompt: `${args.bgPrompt}\n\nIMPORTANT: produce a clean BACKGROUND photo only — NO text, words, letters, numbers, logos, or watermarks. ${themeBgDescriptor} tones.${NO_REAL_PERSON_CLAUSE}`,
        aspectRatio: "3:4",
        title: args.headline,
        topic: args.category || "news",
        ...(referenceImages.length ? { referenceImages } : {}),
      });
      backgroundImageUrl = `data:${bg.mimeType};base64,${bg.imageBase64}`;
      bgSource = "ai";
      imageEngine = bg.source === "dalle" ? "openai" : "gemini";
    } catch (e) {
      // AI failure → fall back to the passed-in real photo (if any), not nothing.
      backgroundImageUrl = args.bgImageUrl ?? backgroundImageUrl;
      console.warn(`[Repurpose] AI background failed, using stock template bg:`, (e as Error).message);
    }
  }

  // If the background is still a raw https:// URL — a CTA slide carrying the
  // article photo, or the AI-failure fallback above — pre-fetch it to a data
  // URI. Puppeteer's `load` event does NOT wait for CSS background-image network
  // fetches, so a remote URL screenshots blank-white; an inline data URI paints
  // synchronously. (AI backgrounds are already data URIs and skip this.)
  // SSRF-gated by safeFetchPublicImage; on any failure we keep the URL and the
  // template's branded gradient still renders (never blank).
  if (backgroundImageUrl?.startsWith("https://")) {
    try {
      const { safeFetchPublicImage } = await import("@postautomation/ai");
      const fetched = await safeFetchPublicImage(backgroundImageUrl, { timeoutMs: 8000 });
      if (fetched) backgroundImageUrl = `data:${fetched.mimeType};base64,${fetched.base64}`;
    } catch {
      /* keep the https:// URL; gradient fallback covers it */
    }
  }

  const creative = await generateStyledCreativeImage({
    style: args.creativeStyle,
    headline: args.headline,
    channelName: args.channelName,
    handle: args.handle,
    logoUrl: args.logoUrl || null,
    logoPosition: args.logoPosition,
    theme: args.theme,
    ...(args.slideRole ? { slideRole: args.slideRole } : {}),
    ...(args.body !== undefined ? { body: args.body } : {}),
    ...(args.browser ? { browser: args.browser } : {}),
    ...(args.hookLine ? { hookLine: args.hookLine } : {}),
    ...(backgroundImageUrl ? { bgImageUrl: backgroundImageUrl } : {}),
    ...(args.brandColor ? { brandColor: args.brandColor } : {}),
  });
  return { imageBase64: creative.imageBase64, mimeType: creative.mimeType, bgSource, imageEngine };
}

/**
 * Minimal structural prisma type for `resolveLogoForOrg` — just the two reads it
 * performs. Keeps the helper testable against a mocked prisma without importing
 * the full `PrismaClient` type (and without `any`).
 */
type LogoResolverPrisma = {
  channel: {
    findFirst: (args: any) => Promise<{ id: string; avatar: string | null; metadata: unknown } | null>;
  };
  media: {
    findFirst: (args: any) => Promise<{ url: string } | null>;
  };
};

/**
 * Shared logo-resolution chain (R3) used by BOTH the main repurpose flow AND the
 * standalone `regenerateImage` mutation, so a regenerated creative keeps the SAME
 * logo (and therefore the same derived brandColor) as the original.
 *
 * Resolution order — IDENTICAL to the old inline main-flow chain:
 *   1. explicit `logoUrl` (caller / template / UI), else
 *   2. DB Media `findFirst` ({ organizationId, category:"logo", channelId }) for a
 *      channel matched by name/handle, else
 *   3. that channel's `metadata.logo_path`, else
 *   4. that channel's `avatar`.
 *
 * The final resolved url is SSRF-validated via `isPublicImageUrl` (dynamically
 * imported from `@postautomation/ai`, same source the callers use) — a
 * private/internal host is dropped (returns `undefined`) so every downstream use
 * (fetch / extractDominantColor / render) is safe. All DB work is best-effort:
 * any read failure degrades to the no-logo path rather than throwing.
 */
export async function resolveLogoForOrg(
  prisma: LogoResolverPrisma,
  opts: { organizationId: string; logoUrl?: string | null; channelName?: string; channelHandle?: string },
): Promise<{ logoUrl: string | undefined }> {
  const { isPublicImageUrl } = await import("@postautomation/ai");
  let resolved = (opts.logoUrl || "").trim();
  const channelName = opts.channelName || "";
  const channelHandle = opts.channelHandle || "";

  if (!resolved && channelName) {
    try {
      const channel = await prisma.channel.findFirst({
        where: {
          organizationId: opts.organizationId,
          OR: [{ name: channelName }, { username: channelHandle || undefined }],
        },
        select: { id: true, avatar: true, metadata: true },
      });
      if (channel) {
        const logoMedia = await prisma.media.findFirst({
          where: { organizationId: opts.organizationId, category: "logo", channelId: channel.id },
          orderBy: { createdAt: "desc" },
        });
        if (logoMedia) {
          resolved = logoMedia.url;
        } else {
          const meta = channel.metadata as any;
          resolved = meta?.logo_path || channel.avatar || "";
        }
      }
    } catch {
      // Non-critical — continue without logo.
    }
  }

  // SSRF chokepoint: drop a private/internal-host logo (graceful no-logo path).
  if (resolved && !isPublicImageUrl(resolved)) {
    console.warn("[repurpose] logo URL blocked (private/internal host) — dropping logo");
    resolved = "";
  }
  return { logoUrl: resolved || undefined };
}

/**
 * Clamp a user-supplied Seedance AI-video DURATION (seconds) into the
 * provider-supported 2–12s range, rounding to the nearest whole second.
 * Nullish/0 falls back to the default 8s (parity with the previous hardcoded
 * value, so existing behaviour is preserved when the field is unset). Note
 * `generateSeedanceVideo` also clamps internally — this is the UI-facing
 * defensive clamp at the enqueue boundary. Pure + exported for unit testing.
 */
export function clampVideoDuration(n: number | undefined): number {
  return Math.max(2, Math.min(12, Math.round(n || 8)));
}

/**
 * Assemble the `RepurposeVideoJobData` payload enqueued to `repurposeVideoQueue`
 * for an async reel / seedance video job (Phase 2b Task 3).
 *
 * The `progressId` is passed through RAW (the verbatim `input.progressId`, e.g.
 * `rep-<ts>-<6char>`) — the WORKER scopes it exactly once via
 * `scopedProgressId(userId, progressId)` so its Redis channel matches the SSE
 * reader. Do NOT pre-scope here, or the worker would double-scope and never
 * match. Pure + exported for unit testing.
 */
export function buildVideoJobData(args: {
  format: "reel" | "seedance_video";
  userId: string;
  organizationId: string;
  progressId: string;
  theme: "dark" | "light" | "gradient";
  reel?: {
    slideUrls: string[];
    voiceOver: boolean;
    bgMusic: boolean;
    voiceType?: string;
    voiceScript?: string;
  };
  seedance?: {
    scenes: string[];
    title: string;
    description: string;
    duration: number;
  };
}): RepurposeVideoJobData {
  return {
    userId: args.userId,
    organizationId: args.organizationId,
    // RAW client id — worker scopes once. See doc-comment above.
    progressId: args.progressId,
    format: args.format,
    theme: args.theme,
    ...(args.reel ? { reel: args.reel } : {}),
    ...(args.seedance ? { seedance: args.seedance } : {}),
  };
}

export const repurposeRouter = createRouter({
  repurpose: protectedProcedure
    .input(
      z.object({
        originalContent: z.string().min(1).max(50000),
        targetPlatforms: z.array(z.string()).min(1).max(16),
        provider: z.enum(["openai", "anthropic", "gemini", "grok", "deepseek", "gemma4"]).default("openai"),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const { repurposeContent } = await import("@postautomation/ai");
        const result = await repurposeContent({
          originalContent: input.originalContent,
          targetPlatforms: input.targetPlatforms,
          provider: input.provider,
        });
        return { platformContent: result };
      } catch (e) {
        // ADD-5: friendly "AI Provider Not Configured" instead of raw 500.
        throw toFriendlyAIError(e);
      }
    }),

  /** Extract content from a URL */
  extractUrl: protectedProcedure
    .input(z.object({ url: z.string().url() }))
    .mutation(async ({ input }) => {
      try {
        const { extractUrlContent } = await import("@postautomation/ai");
        const content = await extractUrlContent(input.url);
        return content;
      } catch (e) {
        throw toFriendlyAIError(e);
      }
    }),

  /**
   * Classify an attached style reference (uploaded image / pasted clipboard image
   * / pasted social-post URL) into the closest of the 4 creative styles, so the
   * Repurpose UI can PRE-SELECT it in the picker (T2a). The user can still override
   * — this only seeds the default; the render path (repurposeFromUrl) honours the
   * user's picked `creativeStyle` regardless of what this returns.
   *
   * Fail-soft by design: a dead / unfetchable / unclassifiable reference returns
   * `{ suggestedStyle: null, confidence: 0 }` and NEVER throws to the client — a
   * classification miss must not break the UI or pop an error toast. The fetch is
   * SSRF-guarded by `safeFetchPublicImage` / `isPublicPageUrl` / `isPublicImageUrl`
   * (fail-closed on private/loopback/metadata hosts) — the url is user-supplied, so
   * it is NEVER fetched without these guards.
   */
  classifyStyleReference: protectedProcedure
    .input(z.object({ aestheticRefUrl: z.string().min(1) }))
    .mutation(
      async ({
        input,
      }): Promise<{
        suggestedStyle:
          | "premium_editorial"
          | "hook_bars"
          | "tweet_card"
          | "bold_typographic"
          | null;
        confidence: number;
        // Round 9: also surface the reference's detected accent + theme so the UI
        // can PRE-FILL the brand-color + theme controls on attach (overridable).
        // Both are already sanitized at source: accentColor via safeColor in
        // classify-card.ts; theme is the "light"|"dark" enum. null when unknown.
        accentColor: string | null;
        theme: "light" | "dark" | null;
      }> => {
        const EMPTY = { suggestedStyle: null, confidence: 0, accentColor: null, theme: null } as const;
        try {
          const {
            safeFetchPublicImage,
            isPublicImageUrl,
            isPublicPageUrl,
            resolveImageFromPageUrl,
            classifyCard,
          } = await import("@postautomation/ai");

          // Fetch the reference image EXACTLY like repurposeFromUrl does: try the
          // url directly, then (for a social POST PAGE, which is text/html) resolve
          // its og:image/twitter:image and fetch THAT. Both paths are SSRF-gated.
          let aRef = await safeFetchPublicImage(input.aestheticRefUrl);
          if (!aRef && isPublicPageUrl(input.aestheticRefUrl)) {
            const og = await resolveImageFromPageUrl(input.aestheticRefUrl);
            if (og && isPublicImageUrl(og)) aRef = await safeFetchPublicImage(og);
          }
          if (!aRef) return EMPTY;

          const hint = await classifyCard(aRef.base64, aRef.mimeType).catch(() => null);
          if (!hint) return EMPTY;

          // presetToCreativeStyle always returns one of the 4 valid style strings.
          const suggestedStyle = presetToCreativeStyle(hint.preset) as
            | "premium_editorial"
            | "hook_bars"
            | "tweet_card"
            | "bold_typographic";
          return {
            suggestedStyle,
            confidence: hint.confidence,
            accentColor: hint.accentColor ?? null,
            theme: hint.theme ?? null,
          };
        } catch {
          // Fail-soft: never surface a reference-classification miss to the client.
          return EMPTY;
        }
      },
    ),

  /** Repurpose from URL — generates caption + media (static/carousel/reel) */
  repurposeFromUrl: orgProcedure
    .input(
      z.object({
        url: z.string().url(),
        progressId: z.string().optional(),
        format: z.enum(["static", "carousel", "reel", "ai_video", "seedance_video"]),
        targetPlatforms: z.array(z.string()).min(1).max(16),
        // Default to OpenAI for TEXT generation: the Google-family providers
        // (gemini/gemma4) share the project that is currently on a billing
        // hold (403 "Lightning dunning"), which would kill caption generation
        // before any media work. OpenAI is the verified-working default.
        provider: z.enum(["openai", "anthropic", "gemini", "grok", "deepseek", "gemma4"]).default("openai"),
        channelName: z.string().optional().default(""),
        channelHandle: z.string().optional().default(""),
        logoUrl: z.string().optional().default(""),
        creativeStyle: z
          .enum(["premium_editorial", "hook_bars", "tweet_card", "bold_typographic"])
          .default("premium_editorial"),
        logoPosition: z.enum(["top-left", "top-right"]).default("top-right"),
        accentColor: z.string().nullish(),
        // E1: an aesthetic/style reference image the AI mimics (Gemini-only —
        // the OpenAI fallback ignores reference images; degrade silently).
        aestheticRefUrl: z.string().optional(),
        // Round 10: when true (and a usable aesthetic reference exists), the static
        // post + carousel COVER are generated via Gemini image-to-image that
        // RECREATES the reference's layout (not just its color). OFF (default) =
        // the existing 4-template render, byte-identical. UI shows the toggle only
        // when a reference is attached.
        referenceMimicry: z.boolean().default(false),
        // Round 10 D5: "ai" = the model renders the headline too (most faithful);
        // "overlay" = the model leaves headline space and code overlays exact text
        // (always correct/editable). Default "ai" — the visual gate proved the AI-
        // rendered headline sits cleanly in the recreated layout, while "overlay"'s
        // fixed bottom band can collide with a mimicked footer (user decision 2026-06-15).
        mimicryTextMode: z.enum(["ai", "overlay"]).default("ai"),
        // E3a: free-text style notes appended to the AI background prompt.
        imageContext: z.string().max(300).optional(),
        // E2 / round3: total slides incl. cover + CTA; min 3 = cover+1 content+cta.
        // Carousel content slides = slideCount - 2 (min 1). (Reel/slideshow has no
        // picker and reads slideCount directly as its content-slide count.)
        slideCount: z.number().int().min(3).max(10).default(5),
        // E4: user-attached image(s). When set on a STATIC repurpose, these
        // BECOME the post media and the AI image generation is SKIPPED (captions
        // still generate). IDOR-sensitive — org-scoped before use in the static
        // branch. STATIC only for now (carousel/video attach is future).
        userMediaIds: z.array(z.string()).max(10).optional(),
        // D2 (Real⇄AI toggle): when false, AI image generation is OFF and every
        // image slot resolves real-first (user → article → branded gradient).
        // Default true preserves the prior always-AI behaviour.
        aiImages: z.boolean().default(true),
        // D10: per-slot user image assignments (all formats). Each {slot, mediaId}
        // assigns an org-owned Media id to a named slot ("background", "slide:0",
        // "slide:2", …). Org-ownership is enforced ONCE up-front (IDOR). When
        // present, this TAKES PRECEDENCE over the legacy static-only `userMediaIds`
        // (the legacy multi-image branch is skipped). The new UI sends this instead
        // of userMediaIds.
        imageAssignments: z
          .array(z.object({ slot: z.string().min(1).max(40), mediaId: z.string().min(1) }))
          .max(20)
          .optional(),
        theme: z.enum(["dark", "light", "gradient"]).default("light"),
        // D7a: user-selectable Seedance AI-video clip length (seconds). The
        // provider supports 2–12s; default 8 preserves the prior hardcoded value.
        // Only consumed by the seedance_video enqueue path.
        videoDuration: z.number().int().min(2).max(12).default(8),
        voiceOver: z.boolean().default(false),
        voiceType: z.enum(["nova", "shimmer", "alloy", "echo", "fable", "onyx"]).default("nova"),
        bgMusic: z.boolean().default(false),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Seedance & AI video are Pro/Enterprise only. Use the shared plan helper
      // so superadmins (ctx.isSuperAdmin) bypass the gate — matching every
      // other plan gate in the codebase. The previous hand-rolled
      // `org.plan === "FREE"||"STARTER"` check was the SOLE gate that ignored
      // isSuperAdmin, which wrongly blocked tabish@dashmani.com (a superadmin
      // whose personal org is on FREE) from AI video.
      if (input.format === "seedance_video" || input.format === "ai_video") {
        await requirePlan(
          ctx.organizationId,
          "PROFESSIONAL",
          "AI video generation",
          ctx.isSuperAdmin,
        );
      }

      const {
        extractUrlContent,
        repurposeContent,
        generateReelVideo,
        generateContent,
        generateSpeech,
        generateVoiceOverScript,
        generateImage: generateGeminiImage,
        generateImageSafe,
        enforceNoHashtags,
        generateVideo: generateVeo3Video,
        buildVideoPrompt,
        overlayLogoOnImage,
        generateStyledCreativeImage,
        launchCreativeBrowser,
        extractDominantColor,
        isPublicImageUrl,
        safeFetchPublicImage,
        resolveImageFromPageUrl,
        isPublicPageUrl,
        describeImageStyle,
        // D10: per-slot real-first image ladder (user → AI → article → branded).
        resolveImageSlot,
        // Component 3: structured layout detection for the aesthetic reference
        // (supplies theme + accent; the user's picked style decides the layout family).
        classifyCard,
      } = await import("@postautomation/ai");

      const userId = (ctx.session.user as any).id as string;
      const organizationId = ctx.organizationId;

      // Progress tracking — fire-and-forget, never blocks. Hoisted ABOVE the
      // logo/aesthetic-reference resolution so those steps can report into the
      // activity log too (they used to fail silently with only a console.warn).
      // Scope the client-supplied id by the authenticated userId so the Redis
      // keys/channels are per-user (closes a cross-tenant IDOR — the reader in
      // apps/web/app/api/progress/route.ts scopes by session.user.id identically).
      const pid = input.progressId ? scopedProgressId(userId, input.progressId) : undefined;
      const progress = (step: string, status: "running" | "done" | "error" | "skipped" = "running", detail?: string) => {
        if (pid) pushProgress(pid, step, status, detail).catch(() => {});
      };

      // Build [chosen → openai → anthropic], deduped, skipping keys that are
      // absent in the environment so we never route to an unconfigured provider.
      // Always includes at least one entry: falls back to "openai" if the chain
      // would otherwise be empty (e.g. all keys absent in a test environment).
      function buildProviderChain(chosen: string | undefined): string[] {
        const safe = chosen || "openai";
        const configured: Record<string, boolean> = {
          openai:    !!process.env.OPENAI_API_KEY,
          anthropic: !!process.env.ANTHROPIC_API_KEY,
          gemini:    !!(process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY),
          gemma4:    !!(process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY),
          grok:      !!process.env.XAI_API_KEY,
          deepseek:  !!process.env.DEEPSEEK_API_KEY,
        };
        const seen = new Set<string>();
        const chain = [safe, "openai", "anthropic"].filter((p) => {
          if (seen.has(p)) return false;
          seen.add(p);
          return configured[p] ?? true; // unknown providers (e.g. in tests) pass through
        });
        // Guarantee at least the chosen provider is tried — even if unconfigured —
        // so the caller always gets a meaningful error rather than silent no-op.
        return chain.length > 0 ? chain : [safe];
      }

      // Text-provider resilience: tries [chosen → openai → anthropic] in order,
      // skipping unconfigured providers, throwing only after the full chain fails.
      // Previously fell back only to OpenAI — when OpenAI itself was quota-degraded,
      // Anthropic (healthy) was never tried and every dead provider produced a hard
      // failure.
      async function repurposeContentResilient(
        args: Parameters<typeof repurposeContent>[0],
      ): Promise<Awaited<ReturnType<typeof repurposeContent>>> {
        const chain = buildProviderChain(args.provider);
        let lastErr: unknown;
        for (const p of chain) {
          try {
            return await repurposeContent({ ...args, provider: p as typeof args.provider });
          } catch (e) {
            const msg = e instanceof Error ? e.message.slice(0, 80) : String(e ?? "unknown error");
            console.warn(`[Repurpose] Caption gen via ${p} failed (${msg})${chain.indexOf(p) < chain.length - 1 ? ", trying next provider" : ""}`);
            lastErr = e;
          }
        }
        throw lastErr;
      }
      async function generateContentResilient(
        args: Parameters<typeof generateContent>[0],
      ): Promise<string> {
        const chain = buildProviderChain(args.provider);
        let lastErr: unknown;
        for (const p of chain) {
          try {
            return await generateContent({ ...args, provider: p as typeof args.provider });
          } catch (e) {
            const msg = e instanceof Error ? e.message.slice(0, 80) : String(e ?? "unknown error");
            console.warn(`[Repurpose] generateContent via ${p} failed (${msg})${chain.indexOf(p) < chain.length - 1 ? ", trying next provider" : ""}`);
            lastErr = e;
          }
        }
        throw lastErr as Error;
      }

      // Resolve logo via the shared resolver (R3): input.logoUrl → DB media
      // (category:"logo") → channel metadata.logo_path → channel avatar. The
      // SAME helper backs `regenerateImage`, so a regenerated creative keeps the
      // identical logo + derived brandColor. The resolver SSRF-validates the
      // final url (`isPublicImageUrl`) and drops a private/internal host — every
      // downstream use (reference fetch, extractDominantColor,
      // buildHeadlineCreative, applyLogoOverlay) is therefore safe.
      const channelName = input.channelName || "";
      const channelHandle = input.channelHandle || "";
      const { logoUrl: resolvedLogoOrUndef } = await resolveLogoForOrg(ctx.prisma, {
        organizationId,
        logoUrl: input.logoUrl,
        channelName,
        channelHandle,
      });
      let resolvedLogoUrl = resolvedLogoOrUndef || "";

      console.log(`[Repurpose] Logo config: logoUrl="${resolvedLogoUrl?.slice(0, 60) || ""}", channelName="${channelName}", handle="${channelHandle}"`);

      // Helper: apply logo overlay to a generated image
      async function applyLogoOverlay(
        imageBase64: string,
        imgMimeType: string,
        imgWidth = 1080,
        imgHeight = 1350,
      ): Promise<{ imageBase64: string; mimeType: string }> {
        if (!resolvedLogoUrl && !channelName) {
          console.log(`[Repurpose] Skipping logo overlay — no logo or channel name`);
          return { imageBase64, mimeType: imgMimeType };
        }
        try {
          console.log(`[Repurpose] Applying logo overlay (${imgWidth}x${imgHeight})...`);
          return await overlayLogoOnImage({
            imageBase64,
            mimeType: imgMimeType,
            width: imgWidth,
            height: imgHeight,
            logoUrl: resolvedLogoUrl || undefined,
            channelName: channelName || undefined,
            channelHandle: channelHandle || undefined,
            position: "bottom-left",
            accentColor: input.accentColor || "#e11d48",
          });
        } catch (e) {
          console.warn(`[Repurpose] Logo overlay failed, using original:`, (e as Error).message);
          return { imageBase64, mimeType: imgMimeType };
        }
      }

      // Logo dominant color — used ONLY as the no-reference fallback for the
      // brand accent (see effectiveBrandColor precedence below). An explicit
      // picker value (input.accentColor) and a detected style-reference accent
      // both take priority, so we resolve this lazily.
      let logoFallbackColor: string | null = null;
      const resolveLogoFallbackColor = async (): Promise<string | null> => {
        if (logoFallbackColor) return logoFallbackColor;
        if (!resolvedLogoUrl) return null;
        try {
          logoFallbackColor = await extractDominantColor(resolvedLogoUrl);
          if (logoFallbackColor) console.log(`[Repurpose] Brand color from logo: ${logoFallbackColor}`);
        } catch {
          /* use template default */
        }
        return logoFallbackColor;
      };

      // Fetch the brand logo once as a reference image so Gemini can style the
      // AI background to match the brand (B4). Gemini-only — the OpenAI fallback
      // ignores it; the logo is baked deterministically by the template either
      // way. A fetch failure degrades silently to no-reference.
      // NOTE: `resolvedLogoUrl` was validated at the SSRF chokepoint above
      // (`isPublicImageUrl`) and cleared if it pointed at a private/internal
      // host, so it is safe to fetch here when truthy. A fetch failure degrades
      // silently to the no-reference path.
      // Round 10: capture the logo bytes at outer scope so buildMimicryCreative
      // can pass them as a distinct logoImage reference (separate from the
      // brandReferenceImages array which conflates logo + aesthetic ref).
      let logoRefImage: { base64: string; mimeType: string } | null = null;
      const brandReferenceImages: Array<{ base64: string; mimeType?: string }> = [];
      if (resolvedLogoUrl) {
        // SSRF-safe: `safeFetchPublicImage` re-checks `isPublicImageUrl`,
        // uses `redirect:"manual"`, requires an image/* content-type, and caps
        // the body. Returns null on any failure → degrade silently.
        const logoRef = await safeFetchPublicImage(resolvedLogoUrl);
        if (logoRef) {
          brandReferenceImages.push({ base64: logoRef.base64, mimeType: logoRef.mimeType });
          logoRefImage = { base64: logoRef.base64, mimeType: logoRef.mimeType };
        }
      }

      // E1: an aesthetic/style reference image the AI mimics, IN ADDITION to the
      // logo. Two things happen with it:
      //   (1) the raw image is pushed into `brandReferenceImages` so Gemini
      //       (Nano Banana) conditions the AI background on it — Gemini-only,
      //       resumes automatically once the Gemini billing hold lifts;
      //   (2) it is sent ONCE to an OpenAI vision model (`describeImageStyle`)
      //       to derive a ~40-word style descriptor that is folded into the
      //       image PROMPT — so gpt-image-1 (the current fallback, which ignores
      //       `referenceImages`) ALSO mimics the style. This is what makes the
      //       feature work provider-agnostically.
      // The url may be an IMAGE url OR a social POST PAGE url (text/html): a
      // post-page yields no image bytes directly, so we fall back to extracting
      // its og:image. All paths fail closed/silently — never throw.
      let aestheticStyleDescriptor: string | undefined;
      // Round 10: hold the SSRF-fetched aesthetic reference bytes at outer scope so
      // the mimicry render path (static + carousel cover) can reuse them — NO new
      // fetch surface (these are the same bytes already fetched + classified below).
      let aestheticRefImage: { base64: string; mimeType: string } | null = null;
      // Hoisted to outer scope (set inside the reference block) so the effective
      // style/theme/accent resolution below can let a classified reference DRIVE
      // the actual render — not just name a saved style.
      let detectedCardHint: Awaited<ReturnType<typeof classifyCard>> = null;
      if (input.aestheticRefUrl) {
        // Surface this step in the activity log: a dead reference url used to
        // degrade with only a server-side console.warn, so users couldn't tell
        // whether their style reference was honoured or silently dropped.
        progress("Analyzing style reference");
        let aRef = await safeFetchPublicImage(input.aestheticRefUrl);
        // Page-url fallback: a social POST PAGE is text/html, not an image, so
        // `safeFetchPublicImage` returns null. Resolve its og:image/twitter:image
        // (self-guarded by `isPublicPageUrl`), then fetch THAT image.
        if (!aRef && isPublicPageUrl(input.aestheticRefUrl)) {
          const og = await resolveImageFromPageUrl(input.aestheticRefUrl);
          if (og && isPublicImageUrl(og)) {
            aRef = await safeFetchPublicImage(og);
          }
        }
        if (aRef) {
          brandReferenceImages.push({ base64: aRef.base64, mimeType: aRef.mimeType });
          aestheticRefImage = { base64: aRef.base64, mimeType: aRef.mimeType };
          try {
            // NOTE: this descriptor is appended to the image-gen prompt and, on the
            // prod billing-403 path, reaches gpt-image-1 UNSANITIZED (sanitizePrompt
            // only fires on a Gemini safety block, not the non-safety fallback). The
            // describe prompt is style-only + capped (≤80 tokens / 300 chars) and the
            // unconditional NO_REAL_PERSON_CLAUSE follows it, so the (cosmetic, own-post)
            // injection blast radius is bounded — do NOT assume sanitizePrompt guards it.
            aestheticStyleDescriptor = (await describeImageStyle(aRef.base64, aRef.mimeType)) || undefined;
          } catch {
            aestheticStyleDescriptor = undefined;
          }
          progress(
            "Analyzing style reference",
            "done",
            aestheticStyleDescriptor
              ? "Style extracted — applied to the AI background"
              : "Reference image found — style description unavailable, using it as-is",
          );

          // Component 3: structured layout detection (in addition to the prose
          // descriptor above). Drives the rendered template + theme/accent below
          // AND names a saved style; failure never blocks generation (→ null).
          let cardHint: Awaited<ReturnType<typeof classifyCard>> = null;
          try {
            cardHint = await classifyCard(aRef.base64, aRef.mimeType);
          } catch {
            cardHint = null;
          }
          detectedCardHint = cardHint;
          // Fix B: NO silent auto-save. We used to auto-create a CreativeTemplate
          // ("News Caption — <date>") whenever a reference classified — confusing
          // (it appeared in the styles gallery with no rename/delete and the user
          // never asked for it). The classification now DRIVES this render (above)
          // and the user saves a style EXPLICITLY via the UI's "Save as template"
          // button when they want to keep it. `shouldPersistReference` /
          // `buildSavedStyleName` remain exported for that explicit path + tests.
        } else {
          console.warn(`[Repurpose] Aesthetic reference unavailable (no image / unfetchable url) — continuing without`);
          progress(
            "Analyzing style reference",
            "error",
            "Couldn't read an image from that link (the site may block automated access) — continuing without the style reference",
          );
        }
      }

      // ── D10 / D2: per-slot image assignments + Real⇄AI toggle ───────────────
      // Engine accounting for the "Image created by X" chip. `renderedEngines`
      // collects every AI engine used this run (static = 1, carousel = per-slide);
      // `lastSlotImageEngine` is the most-recent single engine, used for the static
      // single-image `imageEngine` response field. Hoisted here (was declared just
      // before the format branches) because the slot AI helper below records into
      // them.
      const renderedEngines = new Set<"gemini" | "openai">();
      let lastSlotImageEngine: "gemini" | "openai" | undefined;

      // D10: validate every per-slot assigned media id is org-owned (IDOR) ONCE,
      // then build the userImages lookup consumed by resolveImageSlot. The map is
      // keyed by Media id; resolveImageSlot selects a slot's image via its
      // `userImageId` (the id assigned to that slot). A count mismatch (any id not
      // in this org) throws FORBIDDEN — closes a cross-org image-attach IDOR.
      const slotAssignments: SlotAssignment[] = [...(input.imageAssignments ?? [])];
      let userImages: Record<string, { url: string }> = {};
      if (slotAssignments.length) {
        const ids = [...new Set(slotAssignments.map((a) => a.mediaId))];
        const owned = await ctx.prisma.media.findMany({
          where: { id: { in: ids }, organizationId },
          select: { id: true, url: true },
        });
        if (owned.length !== ids.length) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "One or more attached images were not found in this workspace",
          });
        }
        userImages = resolveSlotAssignments(slotAssignments, owned);
      }
      /** The org-owned Media id assigned to a named slot, if any. */
      const slotMediaId = (slot: string): string | undefined =>
        slotAssignments.find((a) => a.slot === slot)?.mediaId;

      // ── D8: a classified reference DEFINES the look ──────────────────────────
      // When the user uploads/links an aesthetic reference and it classifies, the
      // reference's detected layout/theme/accent DRIVE this render (echoed to the
      // UI by the response below) — previously the detection only named a saved
      // style and the render used the user's dropdown values, so mimicry never
      // happened. No reference (or unclassifiable) → the user's own selections
      // stand, exactly as before. The user's EXPLICIT brand color still wins over
      // a detected accent (an explicit brand decision, not a style guess).
      // T1 (control model): the user's picked creativeStyle ALWAYS decides the
      // layout family. A classified reference no longer overrides it — the
      // reference supplies only theme/accent/logo (effectiveTheme/effectiveBrandColor
      // below), not the style family.
      const effectiveStyle: string = input.creativeStyle;
      const effectiveTheme = detectedCardHint ? detectedCardHint.theme : input.theme;
      // Accent precedence (Round 9): explicit picker > style-reference accent > logo color > null.
      // The reference's detected accent now BEATS the logo color (previously the logo shadowed it,
      // so a reference's color was never applied). An explicit brand-color pick still wins — a
      // deliberate brand decision, not a style guess. Logo color is only the no-reference fallback.
      const effectiveBrandColor: string | null =
        input.accentColor ||
        detectedCardHint?.accentColor ||
        (await resolveLogoFallbackColor()) ||
        null;
      if (detectedCardHint) {
        console.log(
          `[Repurpose] Reference classified as ${detectedCardHint.preset} → effective style=${effectiveStyle} (user pick wins), theme=${effectiveTheme}, accent=${effectiveBrandColor}`,
        );
      }
      // Branded gradient — the always-renders bottom rung of the per-slot ladder.
      const brandGradient = `linear-gradient(135deg, ${effectiveBrandColor || "#e11d48"}, #11131a)`;
      // The AI rung of the ladder: a clean BACKGROUND photo as a data: URL
      // (Gemini → OpenAI via generateImageSafe), mirroring renderStaticCreative's
      // internal AI prompt (theme tones + the UNCONDITIONAL NO_REAL_PERSON clause +
      // brand reference images). resolveImageSlot swallows a failure here and falls
      // through to the article/branded rung — generation never blocks on AI.
      async function generateAiSlotImage(slotPrompt?: string): Promise<string> {
        const themeBgDescriptor =
          effectiveTheme === "light"
            ? "bright, airy, well-lit, clean"
            : effectiveTheme === "gradient"
              ? "vibrant, colorful, dramatic lighting"
              : "dark, moody, dramatic";
        const bg = await generateImageSafe({
          prompt: `${slotPrompt || "Clean editorial background photo"}\n\nIMPORTANT: produce a clean BACKGROUND photo only — NO text, words, letters, numbers, logos, or watermarks. ${themeBgDescriptor} tones.${NO_REAL_PERSON_CLAUSE}`,
          aspectRatio: "3:4",
          ...(brandReferenceImages.length ? { referenceImages: brandReferenceImages } : {}),
        });
        lastSlotImageEngine = bg.source === "dalle" ? "openai" : "gemini";
        renderedEngines.add(lastSlotImageEngine);
        return `data:${bg.mimeType};base64,${bg.imageBase64}`;
      }
      // NOTE: `articleImagesList` + `slotCtx` are declared AFTER `extracted` is
      // resolved below (they read `extracted.images`); the helpers above don't
      // touch `extracted`, so they live here next to the IDOR/userImages setup.

      /**
       * Build a branded "static news creative": deterministic headline text +
       * logo/handle baked onto the image via the Puppeteer news-card template
       * (matches the company's static-post format). The AI image is used only
       * as the background photo. If AI background generation fails (e.g. the
       * Google billing hold), the template still renders with a stock
       * background — so a branded creative is ALWAYS produced, never nothing.
       */
      async function buildHeadlineCreative(
        bgPrompt: string,
        headline: string,
        category: string,
        hookLine?: string,
        // Carousel extras (C4): all slides render through this branded template so
        // the whole set is one consistent visual. `slideRole`/`body` select the
        // layout; `browser` lets the carousel reuse ONE Puppeteer instance across
        // every slide instead of cold-booting Chrome per slide.
        extra?: {
          slideRole?: "cover" | "body" | "cta";
          body?: string;
          // Pass-through shared browser. Typed off launchCreativeBrowser's return
          // so the api package never names "puppeteer" directly (it isn't a dep).
          browser?: Awaited<ReturnType<typeof launchCreativeBrowser>>;
          // The article's own photo (og:image) — the renderer's DEFAULT bg and
          // AI-failure FALLBACK. Every style now generates an AI background that
          // overrides this on success (2026-06-11); the photo is what keeps a
          // creative from rendering "blank" if AI fails. Pass-through, no fetch.
          bgImageUrl?: string;
          // D2: when false, renderStaticCreative skips its internal AI generation
          // and bakes the overlay onto `bgImageUrl` as-is. The repurpose flow sets
          // this false because resolveImageSlot already produced the background.
          aiEnabled?: boolean;
        },
      ): Promise<{ imageBase64: string; mimeType: string; bgSource: "ai" | "stock"; imageEngine?: "gemini" | "openai" }> {
        // Delegate to the module-level renderer (E3b) so the repurpose flow and
        // the standalone `regenerateImage` mutation share ONE render path. The
        // brand logo is passed as a reference image so Gemini (Nano Banana)
        // styles the AI BACKGROUND to match the brand (Gemini-only; the OpenAI
        // fallback ignores references; the logo is always baked by the template).
        return renderStaticCreative({
          ai: { generateImageSafe, generateStyledCreativeImage },
          bgPrompt,
          headline,
          category,
          creativeStyle: effectiveStyle,
          theme: effectiveTheme,
          channelName: displayName,
          handle,
          logoUrl: resolvedLogoUrl || null,
          logoPosition: input.logoPosition,
          brandColor: effectiveBrandColor,
          referenceImages: brandReferenceImages,
          ...(hookLine ? { hookLine } : {}),
          ...(extra?.slideRole ? { slideRole: extra.slideRole } : {}),
          ...(extra?.body !== undefined ? { body: extra.body } : {}),
          ...(extra?.browser ? { browser: extra.browser } : {}),
          ...(extra?.bgImageUrl ? { bgImageUrl: extra.bgImageUrl } : {}),
          ...(extra?.aiEnabled !== undefined ? { aiEnabled: extra.aiEnabled } : {}),
        });
      }

      /**
       * Round 10 — style-mimicry render path (static + carousel cover).
       *
       * Calls `generateReferenceStyledCard` with the hoisted `aestheticRefImage`
       * (the reference fetched + stored in the aRef block above). If both rungs
       * fail the function returns a result with engine: "template", which the
       * caller interprets as "fall back to buildHeadlineCreative".
       *
       * heroUrl: the article's own photo (bgSlot.url) placed into the reference's
       * photo region so the generated card uses real content imagery.
       */
      async function buildMimicryCreative(
        headline: string,
        extra?: { heroUrl?: string },
      ): Promise<import("@postautomation/ai").GenerateReferenceStyledCardResult & { mimeType: string }> {
        if (!aestheticRefImage) {
          // No reference → caller must fall back to template.
          return { imageBase64: "", mimeType: "", engine: "template" };
        }
        const {
          generateReferenceStyledCard,
          overlayHeadlineAndLogo: overlayFn,
          generateImage: nanoBananaGenerate,
        } = await import("@postautomation/ai");

        // Build heroImage from the article bg slot URL (already SSRF-validated
        // by isPublicImageUrl at the slot-resolution stage; re-fetch is safe).
        let heroImage: { base64: string; mimeType: string } | undefined;
        if (extra?.heroUrl) {
          const { safeFetchPublicImage: sfp } = await import("@postautomation/ai");
          const fetched = await sfp(extra.heroUrl).catch(() => null);
          if (fetched) heroImage = { base64: fetched.base64, mimeType: fetched.mimeType };
        }

        // Gemini generate (nano-banana provider — raw, NOT generateImageSafe).
        // generateImageSafe silently falls to a generic prompt dropping the reference
        // images, then to DALL-E, and returns a non-empty image WITHOUT throwing.
        // The mimicry module needs deps.generateImage to throw on Gemini failure so
        // the ladder advances honestly to rung-2 (openai-described).
        const deps: import("@postautomation/ai").ReferenceCardDeps = {
          generateImage: async (params) => {
            const result = await nanoBananaGenerate({
              prompt: params.prompt,
              aspectRatio: params.aspectRatio,
              ...(params.referenceImages ? { referenceImages: params.referenceImages } : {}),
            });
            return { imageBase64: result.imageBase64, mimeType: result.mimeType };
          },
          describeImageStyle: async (base64, mimeType) => {
            const { describeImageStyle } = await import("@postautomation/ai");
            return describeImageStyle(base64, mimeType);
          },
          generateImageDallE: async (params) => {
            const { generateImageDallE: dallE } = await import("@postautomation/ai");
            // Rung 2: call gpt-image-1 directly (generateImageDallE). This path is
            // reached only when Gemini img2img failed, so we go straight to OpenAI.
            const result = await dallE({
              prompt: params.prompt,
              ...(params.size ? { size: params.size as import("@postautomation/ai").DallESize } : {}),
              ...(params.quality ? { quality: params.quality as import("@postautomation/ai").DallEQuality } : {}),
            });
            return { imageBase64: result.imageBase64, mimeType: result.mimeType };
          },
          overlayHeadlineAndLogo: overlayFn,
        };

        const result = await generateReferenceStyledCard(
          {
            referenceImage: aestheticRefImage,
            ...(heroImage ? { heroImage } : {}),
            ...(logoRefImage ? { logoImage: logoRefImage } : {}),
            headline,
            brandName: displayName,
            handle,
            brandColor: effectiveBrandColor,
            textMode: input.mimicryTextMode,
          },
          deps,
        );
        return { ...result, mimeType: result.mimeType || "image/jpeg" };
      }

      // Helper: upload to S3 + create Media record in DB
      async function uploadAndCreateMedia(
        imageBase64: string,
        mimeType: string,
        prefix: string,
      ): Promise<{ url: string; mediaId: string }> {
        const s3 = getS3Client();
        const ext = mimeType.includes("png") ? "png" : mimeType.includes("mp4") ? "mp4" : "jpg";
        const contentType = mimeType.includes("png") ? "image/png" : mimeType.includes("mp4") ? "video/mp4" : "image/jpeg";
        const key = `repurpose/${prefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
        const buf = Buffer.from(imageBase64, "base64");
        const fileSize = buf.length;
        await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: contentType }));
        const url = getPublicUrl(key);

        // Create Media record so it can be attached to posts
        const media = await ctx.prisma.media.create({
          data: {
            organizationId,
            uploadedById: userId,
            fileName: `${prefix}-${Date.now()}.${ext}`,
            fileType: contentType,
            fileSize,
            url,
          },
        });

        return { url, mediaId: media.id };
      }

      // 1. Extract content from URL
      progress("Extracting content from URL");
      console.log(`[Repurpose] Extracting content from: ${input.url}`);
      let extracted;
      try {
        extracted = await extractUrlContent(input.url);
      } catch (e) {
        // Surface a clear, actionable error for the two failure modes here:
        // a missing AI key (→ friendly "not configured") or an unreachable /
        // unparseable URL — instead of a raw 500 (ADD-5 / repurpose e2e).
        if (isMissingAIKeyError(e)) throw toFriendlyAIError(e);
        progress("Extracting content from URL", "error", (e as Error).message);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Couldn't read that URL. Make sure it's a public, reachable page. (${(e as Error).message})`,
        });
      }
      progress("Extracting content from URL", "done", `"${extracted.title}" (${extracted.body.length} chars)`);
      console.log(`[Repurpose] Extracted: "${extracted.title}" (${extracted.body.length} chars)`);

      // D10: the SSRF-filtered list of the source article's photos (https-only,
      // public host) — the resolver's "article" rung, shared by both branches.
      const articleImagesList = (extracted.images ?? []).filter(
        (u: unknown): u is string =>
          typeof u === "string" && u.startsWith("https://") && isPublicImageUrl(u),
      );
      // E: a photo-led reference ("real photo card") + an actual article photo
      // available → prefer the REAL photo over an invented AI background, so a
      // crash/news story doesn't render a generic AI scene when the genuine photo
      // exists. Falls back to the user's Real⇄AI toggle when there's no reference
      // or no real photo to use (else we'd force a flat branded gradient).
      const referencePrefersRealPhoto =
        !!detectedCardHint && isPhotoCardPreset(detectedCardHint.preset) && articleImagesList.length > 0;
      const effectiveAiImages = referencePrefersRealPhoto ? false : input.aiImages;
      if (referencePrefersRealPhoto) {
        console.log(`[Repurpose] Photo-card reference → using the article's real photo (AI background off for this render)`);
      }
      // C: report exactly what the reference drove (never a silent no-op). When a
      // reference classified, say which style/theme/photo it produced; the fetch/
      // classify FAILURE paths above already report their own "couldn't read"/
      // "style extracted" lines.
      if (detectedCardHint) {
        progress(
          "Style reference applied",
          "done",
          `${effectiveStyle.replace(/_/g, " ")} · ${effectiveTheme} theme${
            referencePrefersRealPhoto ? " · your article's real photo" : ""
          }`,
        );
      }
      // Slot resolution context shared by the static + carousel branches. `aiToggle`
      // is the D2 Real⇄AI switch (overridden to real for photo-card references).
      // Return type is inferred + checked structurally at each resolveImageSlot
      // call (no need to import ResolveImageSlotCtx).
      const slotCtx = () => ({
        aiToggle: effectiveAiImages,
        userImages,
        articleImages: articleImagesList,
        brandGradient,
        generateAi: generateAiSlotImage,
      });

      // 2. Understand the content — disambiguate people, identify context, create content brief
      progress("Analyzing content with AI");
      const contentBody = extracted.body.slice(0, 5000) || extracted.description || extracted.title;
      let contentBrief = "";
      try {
        const understandPrompt = `You are a content analyst. Analyze this article and provide a clear content brief.

IMPORTANT: Many names are shared by different people. You MUST identify the CORRECT person based on article context.
Examples:
- "Imran Khan" could be the Bollywood actor OR the Pakistani politician/cricketer
- "Chris Brown" could be the singer OR someone else
- "John Smith" could be anyone

Read the FULL article context carefully to determine WHO exactly is being discussed.

Title: ${extracted.title}
Source: ${extracted.siteName} (${extracted.url})
Content: ${contentBody}

Provide a JSON response:
{
  "subject": "Full name and identity of the main person/topic (e.g. 'Imran Khan, Bollywood actor' or 'Imran Khan, former PM of Pakistan')",
  "context": "What is this article about in 2-3 sentences",
  "category": "entertainment/politics/sports/technology/business/health/lifestyle/other",
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "tone": "the emotional tone - inspiring/shocking/informative/controversial/celebratory/sad",
  "visualDescription": "What kind of imagery would best represent this article (describe the ideal image scene)"
}

Return ONLY the JSON, no other text.`;

        const briefResponse = await generateContentResilient({
          provider: input.provider,
          platform: "INSTAGRAM",
          userPrompt: understandPrompt,
          tone: "professional",
        });

        const cleaned = briefResponse.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const brief = JSON.parse(jsonMatch[0]);
          contentBrief = `SUBJECT: ${brief.subject || extracted.title}
CONTEXT: ${brief.context || extracted.description}
CATEGORY: ${brief.category || "general"}
TONE: ${brief.tone || "informative"}
VISUAL: ${brief.visualDescription || ""}
KEYWORDS: ${(brief.keywords || []).join(", ")}`;
          console.log(`[Repurpose] Content understood: ${brief.subject} (${brief.category})`);
          progress("Analyzing content with AI", "done", `${brief.subject} — ${brief.category}`);
        }
      } catch (e) {
        console.warn(`[Repurpose] Content understanding failed, using raw content:`, (e as Error).message);
        progress("Analyzing content with AI", "skipped", "Using raw content");
      }

      // Fallback if content understanding failed
      if (!contentBrief) {
        contentBrief = `SUBJECT: ${extracted.title}\nCONTEXT: ${extracted.description || contentBody.slice(0, 300)}`;
      }

      // 3. Generate platform-specific captions WITH content brief for accuracy
      progress("Generating captions for " + input.targetPlatforms.length + " platforms");
      const sourceText = `${contentBrief}\n\n---\n\nTitle: ${extracted.title}\n\n${extracted.body.slice(0, 5000)}`;
      let platformContent: Awaited<ReturnType<typeof repurposeContent>>;
      try {
        platformContent = await repurposeContentResilient({
          originalContent: sourceText,
          targetPlatforms: input.targetPlatforms,
          provider: input.provider,
        });
      } catch (e) {
        // Core caption generation is required for the whole flow — if the AI
        // provider isn't configured (even after the OpenAI fallback), fail
        // with the friendly message rather than a raw 500 (ADD-5).
        progress("Generating captions", "error", friendlyAIMessage(e));
        throw toFriendlyAIError(e);
      }
      progress("Generating captions for " + input.targetPlatforms.length + " platforms", "done", Object.keys(platformContent).join(", "));

      // 4. Generate media based on format
      const displayName = channelName || extracted.siteName || "Channel";
      const handle = channelHandle || displayName;

      // Headlines are capped via the module-level `capHeadline` (hoisted so the
      // regenerateImage mutation reuses the same logic — ≤12 words / ≤80 chars).

      let mediaUrls: string[] = [];
      let mediaType = "image/jpeg";
      const perPlatformMedia: Record<string, { url: string; mediaId: string }> = {};
      // Ordered slide media IDs for carousel posts (post.create needs real
      // Media rows, not raw S3 urls). Empty for non-carousel formats.
      const carouselMediaIds: string[] = [];
      // The EXACT headline + hook line used to render the creative, surfaced in
      // the response (PART A) so the per-image "Regenerate" can re-render with
      // the SAME inputs (capped headline + hook) instead of the raw page title.
      let renderedHeadline: string | undefined;
      let renderedHookLine: string | undefined;
      let renderedBgSource: "ai" | "real" | "branded" | undefined;
      let renderedImageEngine: "gemini" | "openai" | undefined;
      // Round 10: records which mimicry rung produced the static/cover image, or
      // null when mimicry was OFF or fell through to the template path.
      let renderedMimicryEngine: "gemini-img2img" | "openai-described" | null = null;
      // `renderedEngines` + `lastSlotImageEngine` are declared above (hoisted) so
      // the per-slot AI helper `generateAiSlotImage` can record into them.

      if (input.format === "static" && input.userMediaIds?.length && !input.imageAssignments?.length) {
        // ── E4 (legacy): user attached their own image(s) via userMediaIds ────
        // Skipped when `imageAssignments` is present — the new per-slot path (the
        // `else if (input.format === "static")` render branch below) is then
        // authoritative and handles the "background" slot itself.
        // The uploaded image BECOMES the post media — SKIP the AI image
        // generation entirely (captions were already generated above and are
        // returned regardless). STATIC only.
        //
        // IDOR guard (MANDATORY, runs BEFORE the media is used): the AI-/UI-
        // supplied ids must all resolve org-scoped, or we throw FORBIDDEN.
        // We also need the urls for `mediaUrls`/`mediaMap`, so we fetch the
        // rows directly (org-scoped) rather than calling the void-returning
        // `assertMediaOwned` helper.
        const requestedIds = input.userMediaIds;
        const owned = await ctx.prisma.media.findMany({
          where: { id: { in: requestedIds }, organizationId },
          select: { id: true, url: true },
        });
        if (owned.length !== new Set(requestedIds).size) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "One or more attached images were not found in this workspace",
          });
        }
        // Order the owned rows to match the user's id order (findMany order is
        // not guaranteed). A missing id is impossible here (count check above).
        const byId = new Map(owned.map((m) => [m.id, m.url]));
        const orderedUrls = requestedIds.map((id) => byId.get(id)!);

        mediaUrls = orderedUrls;
        for (let i = 0; i < requestedIds.length; i++) {
          carouselMediaIds.push(requestedIds[i]!);
        }
        // Heuristic content-type for the UI badge — user uploads are typically
        // png/jpg; the first url's extension is good enough (the real fileType
        // lives on the Media row that publish reads).
        mediaType = /\.png(\?|$)/i.test(orderedUrls[0] || "") ? "image/png" : "image/jpeg";
        const firstMedia = { url: orderedUrls[0]!, mediaId: requestedIds[0]! };
        for (const platform of input.targetPlatforms) {
          perPlatformMedia[platform] = firstMedia;
        }
        progress("Using your uploaded image", "done", `${requestedIds.length} attached`);
        console.log(`[Repurpose] Using ${requestedIds.length} user-attached image(s) — skipping AI generation`);
      } else if (input.format === "static") {
        // Build ONE branded headline creative (deterministic headline + logo/
        // handle baked on via the news-card template — the company's static
        // format) and reuse it for every selected platform. The format is
        // identical per platform; only the caption text differs, so a single
        // 1080×1350 render is correct and avoids N redundant Puppeteer passes.
        const contentSummary = extracted.body.slice(0, 600) || extracted.description || extracted.title;
        const category = /CATEGORY:\s*([^\n]+)/i.exec(contentBrief)?.[1]?.trim() || extracted.type || "news";

        // Headline for the baked overlay: prefer the AI-derived SUBJECT over a
        // generic site/listing <title>. Feeding a homepage/section URL (e.g.
        // indianexpress.com) yields a useless page title like "Latest News
        // Today, Breaking News ... | The Indian Express"; the content brief's
        // SUBJECT (e.g. "India's GDP and Economic Growth") is far better. Use
        // the title only when it looks like a real, specific headline.
        const briefSubject = /SUBJECT:\s*([^\n]+)/i.exec(contentBrief)?.[1]?.trim() || "";
        const looksGenericTitle =
          /\|\s*\w|breaking news|top headlines|latest news|home\s*[-|]|homepage/i.test(extracted.title) ||
          extracted.title.length > 90;
        const headlineForCreative =
          looksGenericTitle && briefSubject && briefSubject.length > 3
            ? briefSubject.replace(/\s*[-–—,]\s*(bollywood actor|politician|.*)$/i, "").trim() || briefSubject
            : extracted.title;
        if (headlineForCreative !== extracted.title) {
          console.log(`[Repurpose] Using AI subject as headline ("${headlineForCreative}") instead of generic title ("${extracted.title.slice(0, 50)}...")`);
        }

        let headlineForCreativeFinal = headlineForCreative;
        if (extracted.type === "social") {
          // Social captions are not article titles — synthesize a concise headline
          // from the caption/body rather than dumping the raw caption (which may be
          // a long emoji-laden sentence) into the headline slot.
          try {
            const synth = await generateContentResilient({
              provider: input.provider,
              platform: "INSTAGRAM",
              userPrompt: `Write ONE complete, self-contained, punchy news-style headline (max 14 words, no hashtags, no emojis) summarizing this social post. Return ONLY the headline text.\n\nPost: ${(extracted.body || extracted.description || extracted.title).slice(0, 800)}`,
              tone: "professional",
            });
            const cleaned = synth.replace(/^["']|["']$/g, "").replace(/\n[\s\S]*$/, "").trim();
            if (cleaned.length > 3) headlineForCreativeFinal = cleaned;
          } catch (e) {
            console.warn(`[Repurpose] Social headline synthesis failed, using extracted title:`, (e as Error).message);
          }
        }
        // The user's free-text creative notes may contain WORDING instructions
        // (e.g. "mention Doordarshan in the hook"). Previously they only
        // reached the background-image prompt, so any text instruction was
        // silently ignored. When notes exist, give the AI one chance to honour
        // them in the headline; visual-only notes return it unchanged. Never
        // fails the flow.
        const creativeNotes = input.imageContext?.trim() || "";
        if (creativeNotes) {
          try {
            const rewritten = await generateContentResilient({
              provider: input.provider,
              platform: "INSTAGRAM",
              userPrompt: buildHeadlineRewritePrompt(
                headlineForCreativeFinal,
                contentSummary.slice(0, 500),
                creativeNotes,
              ),
              tone: "professional",
            });
            const cleanedHeadline = rewritten.replace(/^["']|["']$/g, "").replace(/\n[\s\S]*$/, "").trim();
            if (cleanedHeadline.length > 3) headlineForCreativeFinal = cleanedHeadline;
          } catch (e) {
            console.warn(`[Repurpose] Notes-aware headline rewrite failed, keeping original:`, (e as Error).message);
          }
        }
        headlineForCreativeFinal = capHeadline(headlineForCreativeFinal);
        // PART A: surface the exact rendered headline so Regenerate reuses it.
        renderedHeadline = headlineForCreativeFinal;

        const bgPrompt = `Create a cinematic, high-quality BACKGROUND photo for a social post about:

${contentBrief}

Topic: "${headlineForCreativeFinal}"
Context: ${contentSummary.slice(0, 400)}

Use the SUBJECT and CONTEXT above to depict exactly who/what this is about (e.g. "Imran Khan, Bollywood actor" → Bollywood/film imagery, NOT politics). Photorealistic or editorial illustration, dramatic lighting, strong mood, relevant to the topic.`;
        // E3a: append the user's free-text aesthetic/style notes AND the OpenAI
        // vision-derived aesthetic-reference style descriptor (folded into the
        // same imageContext channel). The combined string flows through
        // `sanitizePrompt` inside `generateImageSafe`.
        const bgPromptWithContext = appendImageContext(
          bgPrompt,
          mergeStyleContext(input.imageContext, aestheticStyleDescriptor),
        );

        // Hook line for the `hook_bars` style ONLY — a short punchy hook with one
        // or two **brand-highlighted** words that renderHighlightMarkup turns into
        // accent-color spans. This adds one AI text call, strictly gated on the
        // style so no other style pays for it. Never fails the whole repurpose:
        // on any error we fall back to no hook line.
        let hookLine: string | undefined;
        if (effectiveStyle === "hook_bars") {
          try {
            const rawHook = await generateContentResilient({
              provider: input.provider,
              platform: "INSTAGRAM",
              userPrompt: buildHookLinePrompt(headlineForCreativeFinal, creativeNotes),
              tone: "professional",
            });
            const trimmedHook = rawHook.replace(/^["']|["']$/g, "").replace(/\n[\s\S]*$/, "").trim();
            if (trimmedHook.length > 0) hookLine = capHookLine(trimmedHook);
          } catch (e) {
            console.warn(`[Repurpose] Hook line generation failed, rendering without hook:`, (e as Error).message);
          }
        }
        // PART A: surface the hook line so Regenerate re-renders hook_bars WITH it.
        renderedHookLine = hookLine;

        // The article's OWN photo (og:image, first in extracted.images) is the
        // harmless DEFAULT background that the AI generation overrides on success
        // and falls back to on failure — for EVERY style now (all styles generate
        // an AI background as of 2026-06-11). SSRF-gated by isPublicImageUrl;
        // https-only (safeImageUrl drops http:// downstream anyway).
        const articleBg = pickArticleBgImage(extracted.images, isPublicImageUrl);

        // D10/D2: resolve the single background slot through the real-first ladder:
        //   user-assigned (imageAssignments "background") → AI (if aiImages on, via
        //   generateAiSlotImage) → article og:image → branded gradient.
        // The resolver OWNS the AI rung here, so the creative render below runs with
        // aiEnabled:false (it just bakes the headline/logo overlay onto the resolved
        // background — no second AI generation, no double billing).
        //
        // Fix A (progress regression): the slow ~20-40s AI background generation now
        // runs INSIDE resolveImageSlot (the `generateAi` rung), which reports no
        // progress of its own — so the activity log used to freeze at "Generating
        // captions… done" with only the spinner until the fast Puppeteer bake. Emit
        // a live "Creating background image" step around the resolve when the AI
        // rung will actually run (AI on + no user-assigned image), then report the
        // honest outcome (AI ready / fell back to the real photo or branding).
        const willGenerateAiBg = effectiveAiImages && !slotMediaId("background");
        if (willGenerateAiBg) progress("Creating background image");
        const bgSlot = await resolveImageSlot(
          {
            userImageId: slotMediaId("background"),
            ...(articleBg ? { articleImageUrl: articleBg } : {}),
            aiPrompt: bgPromptWithContext,
          },
          slotCtx(),
        ).catch(() => ({ url: brandGradient, source: "branded" as const }));
        if (willGenerateAiBg) {
          progress(
            "Creating background image",
            "done",
            bgSlot.source === "ai"
              ? "AI background ready"
              : "AI unavailable — using the article photo / branded background",
          );
        }

        // A user-assigned background IS the post media — skip the branded render
        // (parity with the legacy userMediaIds attach, single image). The url came
        // from the org-scoped userImages map (IDOR-checked above); re-resolve the
        // Media row by (url, org) to attach the real id.
        if (bgSlot.source === "user") {
          const m = await ctx.prisma.media.findFirst({
            where: { url: bgSlot.url, organizationId },
            select: { id: true, url: true },
          });
          if (m) {
            mediaUrls = [m.url];
            carouselMediaIds.push(m.id);
            mediaType = /\.png(\?|$)/i.test(m.url) ? "image/png" : "image/jpeg";
            for (const platform of input.targetPlatforms) perPlatformMedia[platform] = { url: m.url, mediaId: m.id };
            renderedBgSource = "real";
            progress("Using your image", "done", "Your uploaded image");
            console.log(`[Repurpose] Static using user-assigned background image: ${m.url}`);
          }
        }

        if (mediaUrls.length === 0) {
          // T3 no-photo guard: a branded slot means no user image, no article photo, and
          // AI off/unavailable. Rather than render a blank gradient + floating headline,
          // block with an actionable error the UI surfaces as a toast (locked decision).
          // This MUST be before the try/catch below — that catch swallows render errors
          // (friendlyAIMessage + continue), so a throw inside it would never reach the
          // client. Placed here, the TRPCError propagates straight to the UI.
          if (bgSlot.source === "branded") {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Add a hero photo — paste or upload one — or turn on AI image generation. This style needs a background image and none was available (no article photo found and AI image generation is off or unavailable).",
            });
          }
          try {
            progress("Generating creative");
            console.log(`[Repurpose] Building branded headline creative (category=${category}, bgSource=${bgSlot.source})...`);

            // Round 10: mimicry-first path — attempt to reproduce the reference's
            // layout via Gemini img2img (+ OpenAI fallback). Only active when the
            // user has enabled `referenceMimicry` AND an aesthetic reference was
            // successfully fetched above. Falls through to the 4-template path on
            // engine: "template" (both rungs failed) or when mimicry is off.
            let creative: { imageBase64: string; mimeType: string; bgSource?: "ai" | "stock"; imageEngine?: "gemini" | "openai" };
            if (input.referenceMimicry && aestheticRefImage) {
              progress("Generating creative", "running", "Mimicking reference layout via Gemini…");
              const m = await buildMimicryCreative(headlineForCreativeFinal, { heroUrl: bgSlot.url }).catch(() => null);
              if (m && m.engine !== "template" && m.imageBase64) {
                creative = { imageBase64: m.imageBase64, mimeType: m.mimeType };
                renderedMimicryEngine = m.engine as "gemini-img2img" | "openai-described";
                console.log(`[Repurpose] Mimicry succeeded (engine=${m.engine})`);
              } else {
                console.log(`[Repurpose] Mimicry fell through to template path (engine=${m?.engine ?? "null"})`);
                // T1 (control model): ALWAYS render via the template engine
                // (buildHeadlineCreative → buildStaticCreative). The user's picked
                // creativeStyle decides the layout family; the block engine no longer
                // hijacks the Repurpose styled-output path.
                creative = await buildHeadlineCreative(
                  bgPromptWithContext,
                  headlineForCreativeFinal,
                  category,
                  hookLine,
                  {
                    // The slot ladder already resolved the bg (incl. AI); bake-only.
                    aiEnabled: false,
                    // The T3 guard above threw for the branded-gradient rung, so the
                    // slot here is always user/article/ai — all of which carry a real
                    // bg url to bake into the template.
                    bgImageUrl: bgSlot.url,
                  },
                );
              }
            } else {
              // T1 (control model): ALWAYS render via the template engine
              // (buildHeadlineCreative → buildStaticCreative). The user's picked
              // creativeStyle decides the layout family; the block engine no longer
              // hijacks the Repurpose styled-output path.
              creative = await buildHeadlineCreative(
                bgPromptWithContext,
                headlineForCreativeFinal,
                category,
                hookLine,
                {
                  // The slot ladder already resolved the bg (incl. AI); bake-only.
                  aiEnabled: false,
                  // The T3 guard above threw for the branded-gradient rung, so the
                  // slot here is always user/article/ai — all of which carry a real
                  // bg url to bake into the template.
                  bgImageUrl: bgSlot.url,
                },
              );
            }

            const { url, mediaId } = await uploadAndCreateMedia(
              creative.imageBase64,
              creative.mimeType,
              "static",
            );
            mediaUrls.push(url);
            mediaType = creative.mimeType.includes("png") ? "image/png" : "image/jpeg";
            // Same creative for every platform (caption differs per platform).
            for (const platform of input.targetPlatforms) {
              perPlatformMedia[platform] = { url, mediaId };
            }
            // Honest source/engine: AI only when the slot actually resolved to AI;
            // the engine was recorded by generateAiSlotImage into lastSlotImageEngine.
            renderedBgSource = bgSlot.source === "ai" ? "ai" : "real";
            if (bgSlot.source === "ai") renderedImageEngine = lastSlotImageEngine;
            progress(
              "Generating creative",
              "done",
              bgSlot.source === "ai"
                ? "Uploaded to S3"
                : "Uploaded to S3 (real/branded background — AI off or unavailable)",
            );
            console.log(`[Repurpose] Static creative uploaded: ${url} (mediaId: ${mediaId}, bg: ${bgSlot.source})`);
          } catch (e) {
            // The template renderer itself failed (Puppeteer/asset issue). This
            // is the genuine no-image case — surface it loudly (Fix 4) but with
            // a sanitized message (no raw provider internals / project IDs).
            progress("Generating creative", "error", friendlyAIMessage(e));
            console.error(`[Repurpose] Static creative FAILED:`, (e as Error).message);
          }
        }
      } else if (input.format === "ai_video") {
        // ── Veo3 Ultra AI Video Generation ─────────────────────────────
        // 1. Break content into key points for video scenes
        const slidePrompt = `Analyze this content and extract 4-6 key points for a short video.

${contentBrief}

Title: ${extracted.title}
Content: ${extracted.body.slice(0, 4000)}

Return a JSON array of strings — each is a short, punchy point (max 15 words each).
Example: ["AI is transforming marketing", "Content creation is now 10x faster", "Brands see 3x engagement"]

Return ONLY the JSON array, no other text.`;

        let keyPoints: string[] = [];
        progress("Extracting key points for video scenes");
        try {
          const kpResponse = await generateContentResilient({
            provider: input.provider,
            platform: "INSTAGRAM",
            userPrompt: slidePrompt,
            tone: "professional",
          });
          const cleaned = kpResponse.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
          const arrMatch = cleaned.match(/\[[\s\S]*\]/);
          if (arrMatch) keyPoints = JSON.parse(arrMatch[0]);
        } catch (e) {
          progress("Extracting key points for video scenes", "error", friendlyAIMessage(e));
          console.warn(`[Repurpose] Key point extraction failed:`, (e as Error).message);
        }

        if (keyPoints.length === 0) {
          const sentences = extracted.body.split(/[.!?]+/).filter((s) => s.trim().length > 20);
          keyPoints = sentences.slice(0, 5).map((s) => s.trim().slice(0, 80));
        }
        // Publish "done" AFTER the sentence-fallback fills keyPoints so the scene
        // count is the final value (parity with the seedance branch).
        progress("Extracting key points for video scenes", "done", `${keyPoints.length} scenes`);

        // 2. Build cinematic video prompt
        const musicMood = input.theme === "dark" ? "dramatic, cinematic, deep bass" :
          input.theme === "gradient" ? "upbeat electronic, modern" : "clean corporate, optimistic";

        const videoPrompt = buildVideoPrompt({
          title: extracted.title.slice(0, 60),
          keyPoints,
          visualStyle: `${input.theme} theme, professional social media video, cinematic B-roll`,
          musicMood,
          brandName: input.channelName || undefined,
        });

        progress("Generating reference image for Veo3");
        console.log(`[Repurpose] Generating Veo3 AI video (${keyPoints.length} scenes)...`);

        // 3. Also generate a reference image for visual style guidance
        let referenceImage: { base64: string; mimeType?: string } | undefined;
        try {
          const refResult = await generateGeminiImage({
            prompt: enforceNoHashtags(
              `Create a cinematic vertical still frame for a social media video about: "${extracted.title}". ${input.theme} theme, dark background, dramatic lighting, bold white text overlay, modern design. 9:16 portrait vertical.`
            ),
            aspectRatio: "9:16",
          });
          referenceImage = { base64: refResult.imageBase64, mimeType: refResult.mimeType };
          progress("Generating reference image for Veo3", "done");
          console.log(`[Repurpose] Reference image generated for Veo3`);
        } catch (e) {
          progress("Generating reference image for Veo3", "skipped", (e as Error).message);
          console.warn(`[Repurpose] Reference image failed (continuing without):`, (e as Error).message);
        }

        // 4. Generate video with Veo3
        progress("Generating AI video with Veo3 Ultra (1-3 min)");
        try {
          const veoResult = await generateVeo3Video({
            prompt: videoPrompt,
            referenceImage,
            durationSeconds: 8,
            aspectRatio: "9:16",
            personGeneration: "allow_adult",
          });

          // 5. Upload video to S3
          const videoKey = `repurpose/veo3-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp4`;
          const videoBuf = Buffer.from(veoResult.videoBase64, "base64");
          const s3 = getS3Client();
          await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: videoKey, Body: videoBuf, ContentType: "video/mp4" }));

          const videoUrl = getPublicUrl(videoKey);

          // Create Media record
          await ctx.prisma.media.create({
            data: {
              organizationId,
              uploadedById: userId,
              fileName: `veo3-video-${Date.now()}.mp4`,
              fileType: "video/mp4",
              fileSize: videoBuf.length,
              url: videoUrl,
              duration: veoResult.durationSeconds,
            },
          });

          mediaUrls = [videoUrl];
          mediaType = "video/mp4";
          progress("Generating AI video with Veo3 Ultra (1-3 min)", "done", `${(videoBuf.length / 1024 / 1024).toFixed(1)}MB uploaded`);
          console.log(`[Repurpose] Veo3 video uploaded: ${videoUrl} (${(videoBuf.length / 1024 / 1024).toFixed(1)}MB)`);
        } catch (e) {
          progress("Generating AI video with Veo3 Ultra (1-3 min)", "error", friendlyAIMessage(e));
          progress("Falling back to slideshow reel");
          console.error(`[Repurpose] Veo3 generation failed, falling back to slideshow reel:`, (e as Error).message);

          // Fallback: generate slideshow reel from images (same as "reel" format)
          try {
            const slideImages: Array<{ imageBase64: string; mimeType: string }> = [];
            for (const point of keyPoints.slice(0, 6)) {
              try {
                const img = await generateGeminiImage({
                  prompt: enforceNoHashtags(
                    `Create a professional social media slide. Text: "${point}". ${input.theme} theme, cinematic, bold typography, relevant visual background. 4:5 portrait.`
                  ),
                  aspectRatio: "3:4",
                });
                // Apply logo overlay to fallback reel slides
                const branded = await applyLogoOverlay(img.imageBase64, img.mimeType, 1080, 1350);
                slideImages.push({ imageBase64: branded.imageBase64, mimeType: branded.mimeType });
              } catch { /* skip failed slide */ }
              await new Promise((r) => setTimeout(r, 1500)); // rate limit
            }

            if (slideImages.length > 0) {
              let voiceOverBase64: string | undefined;
              if (input.voiceOver) {
                try {
                  const script = generateVoiceOverScript(extracted.title, extracted.body, slideImages.length * 3);
                  const ttsResult = await generateSpeech({ text: script, voice: input.voiceType as any, speed: 1.0, model: "tts-1-hd" });
                  voiceOverBase64 = ttsResult.audioBase64;
                } catch {}
              }

              let bgMusicBase64: string | undefined;
              if (input.bgMusic) {
                try {
                  const { execSync } = await import("node:child_process");
                  const { readFileSync, mkdirSync, rmSync } = await import("node:fs");
                  const { join } = await import("node:path");
                  const { tmpdir } = await import("node:os");
                  const musicDir = join(tmpdir(), `bgmusic-${Date.now()}`);
                  mkdirSync(musicDir, { recursive: true });
                  const musicPath = join(musicDir, "bg.mp3");
                  const duration = slideImages.length * 3 + 2;
                  execSync(`ffmpeg -y -f lavfi -i "sine=frequency=110:duration=${duration}" -f lavfi -i "sine=frequency=165:duration=${duration}" -filter_complex "[0:a][1:a]amix=inputs=2,volume=0.3,afade=t=in:d=1,afade=t=out:st=${duration - 1}:d=1[out]" -map "[out]" -c:a libmp3lame -b:a 128k "${musicPath}"`, { timeout: 30_000, stdio: "pipe" });
                  bgMusicBase64 = readFileSync(musicPath).toString("base64");
                  rmSync(musicDir, { recursive: true, force: true });
                } catch {}
              }

              const reelResult = await generateReelVideo({
                slideImages,
                slideDuration: 3,
                width: 1080,
                height: 1350,
                voiceOverBase64,
                bgMusicBase64,
              });

              const s3 = getS3Client();
              const videoKey = `repurpose/veo3-fallback-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp4`;
              const videoBuf = Buffer.from(reelResult.videoBase64, "base64");
              await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: videoKey, Body: videoBuf, ContentType: "video/mp4" }));
              mediaUrls = [getPublicUrl(videoKey)];
              mediaType = "video/mp4";
              console.log(`[Repurpose] Fallback slideshow reel uploaded: ${mediaUrls[0]}`);
            }
          } catch (fallbackErr) {
            console.error(`[Repurpose] Fallback reel also failed:`, (fallbackErr as Error).message);
          }
        }
      } else if (input.format === "seedance_video") {
        // ── Seedance 2.0 AI Video Generation ─────────────────────────────
        progress("Extracting key points for video scenes");
        const slidePrompt = `Analyze this content and extract 4-6 key points for a short video.

${contentBrief}

Title: ${extracted.title}
Content: ${extracted.body.slice(0, 4000)}

Return a JSON array of strings — each is a short, punchy point (max 15 words each).
Return ONLY the JSON array, no other text.`;

        let keyPoints: string[] = [];
        try {
          const kpResponse = await generateContentResilient({
            provider: input.provider,
            platform: "INSTAGRAM",
            userPrompt: slidePrompt,
            tone: "professional",
          });
          const cleaned = kpResponse.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
          const arrMatch = cleaned.match(/\[[\s\S]*\]/);
          if (arrMatch) keyPoints = JSON.parse(arrMatch[0]);
        } catch (e) {
          progress("Extracting key points for video scenes", "error", friendlyAIMessage(e));
        }

        if (keyPoints.length === 0) {
          const sentences = extracted.body.split(/[.!?]+/).filter((s) => s.trim().length > 20);
          keyPoints = sentences.slice(0, 5).map((s) => s.trim().slice(0, 80));
        }
        // Publish the "done" AFTER the sentence-fallback fills keyPoints, so the
        // scene count reflects the final value (was published before the fallback
        // → showed "0 scenes" then "Queued ... 5 scenes" mismatch).
        progress("Extracting key points for video scenes", "done", `${keyPoints.length} scenes`);

        // ── ENQUEUE the Seedance video job (Phase 2b T3) ─────────────────
        // The long (~up to 7.5min) Seedance poll used to run synchronously here,
        // holding the HTTP request open until the request/proxy timed out
        // ("spinner forever"). It now runs in the WORKER (createRepurposeVideoWorker,
        // T2): we enqueue the scene/title/description + duration and return
        // immediately with `videoPending`. The worker builds the Seedance prompt,
        // generates, uploads + creates the Media row, and streams `video_ready` /
        // `video_error` over the SAME progress SSE the UI is already watching.
        progress("Queued AI video for generation", "done", `${keyPoints.length} scenes`);
        await repurposeVideoQueue.add(
          `repurpose-video-${input.progressId}`,
          buildVideoJobData({
            format: "seedance_video",
            userId,
            organizationId,
            // RAW client id — worker scopes once via scopedProgressId.
            progressId: input.progressId ?? "",
            theme: input.theme,
            seedance: {
              scenes: keyPoints,
              title: extracted.title.slice(0, 60),
              description: extracted.description || extracted.body.slice(0, 300),
              // D7a: user-selected clip length, clamped to the provider's 2–12s
              // range (defaults to 8 — parity with the previous hardcoded value).
              duration: clampVideoDuration(input.videoDuration),
            },
          }),
          { attempts: 1 },
        );
        console.log(`[Repurpose] Seedance video job enqueued (${keyPoints.length} scenes), progressId=${input.progressId}`);

        return {
          extracted: {
            title: extracted.title,
            description: extracted.description,
            siteName: extracted.siteName,
            type: extracted.type,
            images: extracted.images,
            url: extracted.url,
          },
          platformContent,
          mediaUrls: [] as string[],
          mediaMap: perPlatformMedia,
          carouselMediaIds: [] as string[],
          mediaType: "video/mp4",
          format: input.format,
          mediaFailed: false,
          // No images are rendered on the AI-video path — engine chip stays hidden.
          imageEngines: [] as ("gemini" | "openai")[],
          // The worker delivers the video via the progress SSE; the UI waits on
          // `video_ready` keyed by this RAW progressId. T4 reads `videoPending`.
          videoPending: true,
          progressId: input.progressId,
        };

      } else if (input.format === "carousel" || input.format === "reel") {
        // LOCKED decision: for a CAROUSEL the user's slideCount picker means the
        // TOTAL slide count (cover + content + CTA), so the content-slide count
        // is total - 2 (min 1). The slideCount picker is carousel-only — the reel
        // (slideshow) path has NO picker, so it keeps its prior behaviour and uses
        // input.slideCount (default 5) content slides directly. The carousel and
        // reel branches SHARE this slide-extraction/enforce code, so we branch the
        // content count here and use `effectiveContentCount` everywhere below.
        const effectiveContentCount =
          input.format === "carousel" ? contentSlidesForTotal(input.slideCount) : input.slideCount;
        // Generate carousel slide content via AI
        const slidePrompt = `Analyze this content and break it into exactly ${effectiveContentCount} key points for a carousel post.

${contentBrief}

Title: ${extracted.title}
Content: ${extracted.body.slice(0, 4000)}

Return a JSON array of objects with "title" (short, 3-6 words) and "body" (1-2 sentences, max 120 chars each).
Example: [{"title": "Key Insight", "body": "The main takeaway explained simply."}]

Return ONLY the JSON array, no other text.`;

        let slideData: Array<{ title: string; body: string }> = [];
        try {
          const slideResponse = await generateContentResilient({
            provider: input.provider,
            platform: "INSTAGRAM",
            userPrompt: slidePrompt,
            tone: "professional",
          });

          const cleaned = slideResponse
            .replace(/```json\s*/g, "")
            .replace(/```\s*/g, "")
            .trim();
          const arrMatch = cleaned.match(/\[[\s\S]*\]/);
          if (arrMatch) {
            slideData = JSON.parse(arrMatch[0]);
          }
        } catch (e) {
          console.warn(`[Repurpose] AI slide generation failed, using fallback:`, (e as Error).message);
        }

        // Fallback slides derived from the body sentences — used both when the
        // AI returns nothing AND to top up an AI list that came back short of
        // the requested count. Generate up to `effectiveContentCount` so
        // enforceSlideCount has enough material to reach the target before generic
        // fillers kick in.
        const fallbackSentences = extracted.body.split(/[.!?]+/).filter((s) => s.trim().length > 20);
        const fallbackSlidesFromSentences = fallbackSentences.slice(0, effectiveContentCount).map((s, i) => ({
          title: `Point ${i + 1}`,
          body: capBody(s, 120),
        }));

        // E2 / round3: honour the user's chosen content-slide count EXACTLY —
        // slice if the AI returned too many, top up from the sentence fallback
        // then generic fillers if too few. Cover + cta are still added around
        // these below. For a carousel `effectiveContentCount = total - 2`, so the
        // published carousel has exactly `slideCount` slides total (cover + N + cta);
        // for a reel `effectiveContentCount = input.slideCount` (unchanged).
        slideData = enforceSlideCount(slideData, effectiveContentCount, fallbackSlidesFromSentences);

        // Generate AI-designed carousel slides using Gemini
        const s3 = getS3Client();
        const uploadedUrls: string[] = [];

        // Build all slide texts: cover + content + CTA
        // Use the same 3-step headline derivation as the static branch so the
        // carousel cover also: (a) swaps a generic site-title for the AI SUBJECT,
        // (b) synthesizes a clean headline from social-post captions, and (c)
        // honours wording instructions from the user's creative notes.
        const carouselContentSummary = extracted.body.slice(0, 600) || extracted.description || extracted.title;
        const carouselCreativeNotes = input.imageContext?.trim() || "";
        const coverHeadline = await deriveCreativeHeadline({
          extracted,
          contentBrief,
          contentSummary: carouselContentSummary,
          creativeNotes: carouselCreativeNotes,
          generateFn: (prompt) =>
            generateContentResilient({ provider: input.provider, platform: "INSTAGRAM", userPrompt: prompt, tone: "professional" }),
        });
        // PART A: the capped cover headline is what the carousel cover renders —
        // surface it so Regenerate of the cover slide reuses it (not the raw title).
        renderedHeadline = coverHeadline;
        const allSlides = [
          { type: "cover", title: coverHeadline, body: extracted.description ? capBody(extracted.description, 100) : "" },
          ...slideData.map((d, i) => ({ type: "content", title: d.title, body: d.body })),
          { type: "cta", title: "Follow for More", body: "" },
        ];

        progress(`Generating ${allSlides.length} carousel slides`);
        console.log(`[Repurpose] Generating ${allSlides.length} AI carousel slides...`);

        // ── ALL slides through ONE branded template + ONE browser (C4/N13) ──
        // Every slide — cover, content (body), cta — now renders through
        // buildHeadlineCreative → the branded Puppeteer template. Previously the
        // cover used the template while body/cta slides used a raw AI image +
        // logo watermark, so slide 1 looked branded and slides 2+ looked like a
        // different design entirely. Routing all slides through the same template
        // (with slideRole selecting the layout) makes the carousel one set.
        //
        // We also launch ONE browser for the whole carousel and pass it to every
        // generateStyledCreativeImage call — instead of cold-booting Chrome per
        // slide (7+ launches per carousel → 1).
        const slideImages: Array<{ imageBase64: string; mimeType: string }> = [];
        const BATCH_SIZE = 3;
        const DELAY_BETWEEN_BATCHES = 3000; // 3s between batches
        const category = /CATEGORY:\s*([^\n]+)/i.exec(contentBrief)?.[1]?.trim() || extracted.type || "news";
        // ONLY the CATEGORY/TONE lines of the brief (computed once) — NOT the full
        // SUBJECT/VISUAL brief. Feeding the whole brief per slide is exactly what
        // made every slide's prompt ~95% identical (same SUBJECT person each time).
        const categoryTone = [
          contentBrief.match(/CATEGORY:[^\n]*/)?.[0],
          contentBrief.match(/TONE:[^\n]*/)?.[0],
        ]
          .filter(Boolean)
          .join(" ")
          .trim();
        // LOCKED decision: the COVER slide sits on the real article photo (the
        // same source the static-post cover uses). Body/cta slides keep the
        // per-slide variety AI background (cta skips AI entirely in the renderer).
        const coverArticleBg = pickArticleBgImage(extracted.images, isPublicImageUrl);

        // T3 no-photo guard (carousel COVER only — NOT reel, a video path). The
        // cover mirrors the static post and must have a usable photo; body/cta
        // slides legitimately use branded gradients by design, so we never block
        // those. We pre-flight ONLY when AI is effectively OFF for the cover
        // (!effectiveAiImages): when AI is ON the cover resolves to an AI bg
        // (source "ai") so it won't be branded — and a check here would have to
        // call AI a second time, which is unacceptable. With AI off, the cover is
        // branded iff there's no user image for slide:0 AND no article photo —
        // cheap to detect up-front (no AI call, no double-resolve). The per-slide
        // loop below re-resolves the cover normally; this only decides whether to
        // block, so the UI gets a toast instead of a blank gradient + floating box.
        if (input.format === "carousel" && !effectiveAiImages) {
          const coverUserId = slotMediaId("slide:0");
          const coverHasUserImage = !!(coverUserId && userImages[coverUserId]);
          const coverHasPhoto = coverHasUserImage || !!coverArticleBg;
          if (!coverHasPhoto) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Add a hero photo — paste or upload one — or turn on AI image generation. This style needs a background image and none was available (no article photo found and AI image generation is off or unavailable).",
            });
          }
        }

        const carouselBrowser = await launchCreativeBrowser();
        try {
          for (let batchStart = 0; batchStart < allSlides.length; batchStart += BATCH_SIZE) {
            if (batchStart > 0) {
              await new Promise((r) => setTimeout(r, DELAY_BETWEEN_BATCHES));
            }

            const batchEnd = Math.min(batchStart + BATCH_SIZE, allSlides.length);
            const batchPromises = allSlides.slice(batchStart, batchEnd).map(async (slideMeta, batchIdx) => {
              const slideIdx = batchStart + batchIdx;
              const slideRole: "cover" | "body" | "cta" =
                slideMeta.type === "cover" ? "cover" : slideMeta.type === "cta" ? "cta" : "body";
              // Per-slide error isolation: one bad slide must NOT abort the
              // carousel or kill the shared browser — skip it (null) and keep
              // going, exactly like the previous resilience.
              try {
                const headline = slideMeta.title;
                // Per-slide variety: distinct camera angle + the slide's OWN
                // title/body + only CATEGORY/TONE (not the repeated full brief).
                const bgPrompt = buildCarouselSlidePrompt(
                  {
                    slideTitle: slideMeta.title,
                    slideBody: slideMeta.body,
                    slideIdx,
                    totalSlides: allSlides.length,
                    categoryTone,
                    // Fold the OpenAI vision aesthetic-reference descriptor into
                    // the per-slide imageContext (computed ONCE above, reused for
                    // every slide) so the carousel mimics the reference style too.
                    imageContext: mergeStyleContext(input.imageContext, aestheticStyleDescriptor),
                  },
                  appendImageContext,
                );
                // Every non-cta slide now gets an AI background (2026-06-11). The
                // cover passes the article photo as its AI-failure FALLBACK (the AI
                // overrides it on success); body slides get per-slide AI variety;
                // cta renders a branded-gradient "Follow for more" card.
                const isCover = slideRole === "cover" || slideIdx === 0;
                const isCta = slideRole === "cta";
                // D10/D5/D2: resolve THIS slide's background through the real-first
                // ladder. user-assigned (imageAssignments "slide:N") → AI (if on,
                // per-slide variety) → article photo (cover = the article hero; body
                // = cover-hero reuse when AI is off, D5) → branded gradient. The cta
                // slide never gets AI/article — only an explicit user image, else its
                // branded "Follow for more" card. The resolver OWNS the AI rung, so
                // the render runs aiEnabled:false (overlay-only, no double gen).
                let slideBg: string | undefined;
                // The cover slide's resolved bg source, surfaced so the outer
                // `renderedBgSource` reflects the COVER honestly (cta isn't the cover).
                let slideSource: "user" | "ai" | "article" | "branded" | undefined;
                if (isCta) {
                  const ctaUserId = slotMediaId(`slide:${slideIdx}`);
                  if (ctaUserId && userImages[ctaUserId]) slideBg = userImages[ctaUserId]!.url;
                } else {
                  // Body slides fall back to the cover hero first (D5), then any
                  // other article photo; cover uses the article hero only.
                  const bodyFallback = coverArticleBg
                    ? [coverArticleBg, ...articleImagesList]
                    : articleImagesList;
                  const slot = await resolveImageSlot(
                    {
                      userImageId: slotMediaId(`slide:${slideIdx}`),
                      ...(isCover && coverArticleBg ? { articleImageUrl: coverArticleBg } : {}),
                      aiPrompt: bgPrompt,
                    },
                    {
                      ...slotCtx(),
                      articleImages: isCover
                        ? coverArticleBg
                          ? [coverArticleBg]
                          : []
                        : bodyFallback,
                    },
                  ).catch(() => ({ url: brandGradient, source: "branded" as const }));
                  // A branded-gradient rung passes no bgImageUrl so the template
                  // renders its own gradient (a CSS gradient string isn't a url).
                  slideBg = slot.source === "branded" ? undefined : slot.url;
                  slideSource = slot.source;
                }
                // Round 10: for the COVER slide, try mimicry-first when enabled.
                // Body + CTA slides always use the template engine (mimicry is a
                // cover-level concern — body slides carry distinct per-slide body
                // text and are not subject to layout mimicry).
                let creativeBase64: string;
                let creativeMime: string;
                let creativeEngine: string | undefined;
                let slideMimicryEngine: "gemini-img2img" | "openai-described" | null = null;
                if (isCover && input.referenceMimicry && aestheticRefImage) {
                  const m = await buildMimicryCreative(headline, { heroUrl: slideBg }).catch(() => null);
                  if (m && m.engine !== "template" && m.imageBase64) {
                    creativeBase64 = m.imageBase64;
                    creativeMime = m.mimeType || "image/jpeg";
                    slideMimicryEngine = m.engine as "gemini-img2img" | "openai-described";
                  } else {
                    // Mimicry fell through; render via template engine below.
                    const creative = await buildHeadlineCreative(
                      bgPrompt,
                      headline,
                      category,
                      undefined,
                      {
                        slideRole,
                        aiEnabled: false,
                        ...(slideRole === "body" ? { body: slideMeta.body } : {}),
                        ...(slideBg ? { bgImageUrl: slideBg } : {}),
                        browser: carouselBrowser,
                      },
                    );
                    creativeBase64 = creative.imageBase64;
                    creativeMime = creative.mimeType;
                    creativeEngine = creative.imageEngine;
                  }
                } else {
                // T1 (control model): ALWAYS render the cover (and every slide) via
                // the template engine — the user's picked creativeStyle decides the
                // layout family; the block engine no longer hijacks the cover.
                {
                  const creative = await buildHeadlineCreative(
                    bgPrompt,
                    headline,
                    category,
                    undefined,
                    {
                      slideRole,
                      aiEnabled: false, // bg resolved by the slot ladder above
                      ...(slideRole === "body" ? { body: slideMeta.body } : {}),
                      ...(slideBg ? { bgImageUrl: slideBg } : {}),
                      browser: carouselBrowser,
                    },
                  );
                  creativeBase64 = creative.imageBase64;
                  creativeMime = creative.mimeType;
                  creativeEngine = creative.imageEngine;
                }
                } // end else (template path)
                return { slideIdx, imageBase64: creativeBase64!, mimeType: creativeMime!, imageEngine: creativeEngine, source: isCover ? slideSource : undefined, mimicryEngine: slideMimicryEngine };
              } catch (e) {
                console.warn(`[Repurpose] Slide ${slideIdx + 1} (${slideRole}) failed:`, (e as Error).message);
                return null;
              }
            });

            const batchResults = await Promise.all(batchPromises);
            for (const result of batchResults) {
              if (result) {
                slideImages[result.slideIdx] = { imageBase64: result.imageBase64, mimeType: result.mimeType };
                if (result.imageEngine === "gemini" || result.imageEngine === "openai") renderedEngines.add(result.imageEngine);
                if (result.slideIdx === 0 && result.source) {
                  // Round 10: when mimicry succeeded for the cover, the image IS ai-generated
                  // regardless of which slot the source URL came from.
                  renderedBgSource = result.mimicryEngine
                    ? "ai"
                    : result.source === "ai" ? "ai" : result.source === "branded" ? "branded" : "real";
                }
                // Round 10: record which mimicry rung the cover slide used (only cover).
                if (result.slideIdx === 0 && result.mimicryEngine) {
                  renderedMimicryEngine = result.mimicryEngine;
                }
              }
            }
            const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
            const batchOk = batchResults.filter(Boolean).length;
            progress(`Generating ${allSlides.length} carousel slides`, "running", `Batch ${batchNum} done — ${batchOk}/${batchEnd - batchStart} slides`);
            console.log(`[Repurpose] Batch ${batchNum} done (${batchOk}/${batchEnd - batchStart} slides)`);
          }
        } finally {
          await carouselBrowser.close().catch(() => {});
        }

        // Upload all successfully generated slides to S3 AND create a Media row
        // per slide so post.create can attach them (carousel publish fix).
        for (let i = 0; i < slideImages.length; i++) {
          const slide = slideImages[i];
          if (!slide) continue;
          const ext = slide.mimeType.includes("png") ? "png" : "jpg";
          const contentType = slide.mimeType.includes("png") ? "image/png" : "image/jpeg";
          const key = `repurpose/carousel-${Date.now()}-${i}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
          const buf = Buffer.from(slide.imageBase64, "base64");
          await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: contentType }));
          const slideUrl = getPublicUrl(key);
          uploadedUrls.push(slideUrl);
          const media = await ctx.prisma.media.create({
            data: {
              organizationId,
              uploadedById: userId,
              fileName: `carousel-${Date.now()}-${i}.${ext}`,
              fileType: contentType,
              fileSize: buf.length,
              url: slideUrl,
            },
          });
          carouselMediaIds.push(media.id);
        }

        progress(`Generating ${allSlides.length} carousel slides`, "done", `${uploadedUrls.length} uploaded`);
        console.log(`[Repurpose] ${uploadedUrls.length}/${allSlides.length} carousel slides uploaded`);

        if (carouselMediaIds.length > 0) {
          const first = { url: uploadedUrls[0]!, mediaId: carouselMediaIds[0]! };
          for (const platform of input.targetPlatforms) {
            perPlatformMedia[platform] = first;
          }
        }

        if (input.format === "reel") {
          // ── ENQUEUE the reel stitch job (Phase 2b T3) ───────────────────
          // The ffmpeg slide-stitch + TTS + bg-music synthesis used to run
          // synchronously here, holding the HTTP request open (and a raw
          // shell-injection `execSync` for the bg-music tone). It now runs in the
          // WORKER (createRepurposeVideoWorker, T2): we ship the uploaded slide
          // URLs + the voice/music flags and return immediately with
          // `videoPending`. The worker downloads the slides, generates TTS from
          // `voiceScript`, synthesizes the music bed (execFileSync, no shell),
          // stitches, uploads + creates the video Media row, and streams
          // `video_ready` / `video_error` over the SAME progress SSE.
          //
          // Compute the voice-over SCRIPT here (cheap, deterministic) so the
          // worker can synthesize the audio — matches the script the old sync
          // path fed to generateSpeech.
          const voiceScript = input.voiceOver
            ? generateVoiceOverScript(extracted.title, extracted.body, slideImages.length * 3)
            : undefined;

          progress("Queued reel video for stitching", "done", `${uploadedUrls.length} slides`);
          await repurposeVideoQueue.add(
            `repurpose-video-${input.progressId}`,
            buildVideoJobData({
              format: "reel",
              userId,
              organizationId,
              // RAW client id — worker scopes once via scopedProgressId.
              progressId: input.progressId ?? "",
              theme: input.theme,
              reel: {
                slideUrls: uploadedUrls,
                voiceOver: input.voiceOver,
                bgMusic: input.bgMusic,
                voiceType: input.voiceType,
                ...(voiceScript ? { voiceScript } : {}),
              },
            }),
            { attempts: 1 },
          );
          console.log(`[Repurpose] Reel video job enqueued (${uploadedUrls.length} slides), progressId=${input.progressId}`);

          return {
            extracted: {
              title: extracted.title,
              description: extracted.description,
              siteName: extracted.siteName,
              type: extracted.type,
              images: extracted.images,
              url: extracted.url,
            },
            platformContent,
            mediaUrls: [] as string[],
            mediaMap: perPlatformMedia,
            // The publishable asset is the reel VIDEO (created by the worker),
            // not the intermediate slides — so do NOT return the slide ids here.
            carouselMediaIds: [] as string[],
            mediaType: "video/mp4",
            format: input.format,
            mediaFailed: false,
            // The reel's SLIDE images were rendered above — surface their engines
            // now (the chip labels the slide images; the MP4 itself is ffmpeg).
            imageEngines: [...renderedEngines],
            // The worker delivers the video via the progress SSE; the UI waits on
            // `video_ready` keyed by this RAW progressId. T4 reads `videoPending`.
            videoPending: true,
            progressId: input.progressId,
            referenceApplied: !!detectedCardHint,
            appliedStyle: detectedCardHint ? effectiveStyle : null,
            appliedTheme: detectedCardHint ? effectiveTheme : null,
            usedRealPhoto: referencePrefersRealPhoto,
            // Round 10: reel slides don't use mimicry (they are content slides,
            // not a single styled cover), so this is always null here.
            mimicryEngine: null as null,
          };
        } else {
          mediaUrls = uploadedUrls;
        }
      }

      // Fail loudly (Fix 4): every format is expected to produce at least one
      // media asset. If captions generated but ALL media generation failed,
      // do NOT report a false success — the previous behaviour returned an
      // empty mediaUrls with a green "done" status, so the UI silently showed
      // captions and nothing else. Surface it as a real failure instead.
      const mediaFailed = mediaUrls.length === 0;
      if (pid) {
        finishProgress(
          pid,
          mediaFailed ? "error" : "done",
          mediaFailed
            ? `Captions generated, but ${input.format} media could not be produced — check the activity log above for the provider error.`
            : `${Object.keys(platformContent).length} captions, ${mediaUrls.length} media`,
        ).catch(() => {});
      }

      return {
        extracted: {
          title: extracted.title,
          description: extracted.description,
          siteName: extracted.siteName,
          type: extracted.type,
          images: extracted.images,
          url: extracted.url,
        },
        platformContent,
        mediaUrls,
        mediaMap: perPlatformMedia,
        carouselMediaIds,
        mediaType,
        format: input.format,
        // Truthful signal for the UI: captions exist but no media was produced.
        mediaFailed,
        // PART A: the EXACT headline + hook line used to render the creative, so
        // the per-image Regenerate re-renders with the same inputs (capped
        // headline + hook), not the raw extracted page title.
        renderedHeadline: renderedHeadline ?? null,
        hookLine: renderedHookLine ?? null,
        bgSource: renderedBgSource ?? null,
        imageEngine: renderedImageEngine ?? null,
        // Unique AI image engines across ALL rendered images (static + per-slide
        // carousel). [] when every image fell back to article photo/gradient.
        imageEngines: [...renderedEngines],
        // C/D: what an uploaded style reference actually drove this render to, so
        // the UI can confirm it was honoured (vs. the old silent no-op). Null when
        // no reference was classified.
        referenceApplied: !!detectedCardHint,
        appliedStyle: detectedCardHint ? effectiveStyle : null,
        appliedTheme: detectedCardHint ? effectiveTheme : null,
        usedRealPhoto: referencePrefersRealPhoto,
        // Round 10: which mimicry rung actually produced the static/cover image.
        // null = mimicry was OFF or fell through to the template path.
        mimicryEngine: renderedMimicryEngine,
      };
    }),

  /**
   * E3b — Re-roll JUST the static / carousel-cover image without re-running the
   * whole repurpose flow. A NEW write endpoint that renders an AI image, so it
   * is plan-gated (enforcePlanLimit aiImagesPerMonth — can't be a free unlimited
   * image faucet) and SSRF-guarded (logoUrl + aestheticRefUrl validated via
   * isPublicImageUrl before any fetch). Reuses the shared `renderStaticCreative`
   * helper + the same `uploadAndCreateMedia` pattern as the main flow.
   */
  regenerateImage: orgProcedure
    .input(
      z.object({
        headline: z.string().min(1),
        creativeStyle: z
          .enum(["premium_editorial", "hook_bars", "tweet_card", "bold_typographic"])
          .default("premium_editorial"),
        theme: z.enum(["dark", "light", "gradient"]).default("light"),
        logoUrl: z.string().optional(),
        logoPosition: z.enum(["top-left", "top-right"]).default("top-right"),
        accentColor: z.string().nullish(),
        imageContext: z.string().max(300).optional(),
        aestheticRefUrl: z.string().optional(),
        channelName: z.string().optional(),
        channelHandle: z.string().optional(),
        // R3 parity with the main flow: the hook line (hook_bars), the article
        // photo to sit the creative on, and the article-context blurb folded into
        // the AI background prompt — so a regenerated image matches the original.
        hookLine: z.string().optional(),
        bgImageUrl: z.string().url().optional(),
        bgContext: z.string().max(600).optional(),
        // Round 10 parity: when true (and aestheticRefUrl is set), regenerate
        // also uses the mimicry render path instead of the template engine.
        referenceMimicry: z.boolean().default(false),
        mimicryTextMode: z.enum(["ai", "overlay"]).default("ai"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Plan gate FIRST — before any (billable) render. aiImagesPerMonth matches
      // image.router / chat.router generate_news_image. Superadmins bypass.
      await enforcePlanLimit(ctx.organizationId, "aiImagesPerMonth", ctx.isSuperAdmin);

      const {
        generateImageSafe,
        generateStyledCreativeImage,
        extractDominantColor,
        isPublicImageUrl,
        safeFetchPublicImage,
        classifyCard,
      } = await import("@postautomation/ai");

      const userId = (ctx.session.user as any).id as string;
      const organizationId = ctx.organizationId;

      // SSRF chokepoint: drop any user-supplied logo / aesthetic-ref URL that
      // isn't a public host (private/loopback/metadata/internal blocked). A
      // disallowed url degrades silently to the no-logo / no-reference path —
      // never fetched, never thrown.
      const safeAestheticRef =
        input.aestheticRefUrl && isPublicImageUrl(input.aestheticRefUrl)
          ? input.aestheticRefUrl
          : undefined;

      // R3 parity: resolve the logo via the SAME shared chain the main flow uses
      // (input.logoUrl → DB category:"logo" media → channel metadata.logo_path →
      // channel avatar), so a regenerated creative gets the IDENTICAL logo (and
      // hence the same derived brandColor). The resolver SSRF-validates the final
      // url, so `safeLogoUrl` is safe to fetch / colour-extract below.
      const { logoUrl: safeLogoUrl } = await resolveLogoForOrg(ctx.prisma, {
        organizationId,
        logoUrl: input.logoUrl,
        channelName: input.channelName,
        channelHandle: input.channelHandle,
      });

      // Resolve a brand accent color (Round 9 precedence, mirrors the main flow):
      // explicit picker > style-reference detected accent > logo dominant color > default.
      // Without this, hitting "Regenerate" on a creative built from a style reference
      // dropped the reference's color (only picker/logo were consulted).
      let brandColor: string | null = input.accentColor || null;
      if (!brandColor && safeAestheticRef) {
        try {
          const refImg = await safeFetchPublicImage(safeAestheticRef);
          if (refImg) {
            const hint = await classifyCard(refImg.base64, refImg.mimeType).catch(() => null);
            if (hint?.accentColor) brandColor = hint.accentColor;
          }
        } catch {
          /* fall through to logo color */
        }
      }
      if (!brandColor && safeLogoUrl) {
        try {
          brandColor = await extractDominantColor(safeLogoUrl);
        } catch {
          /* template default */
        }
      }

      // Assemble Gemini reference images (logo + aesthetic ref) — mirrors the
      // main flow's `brandReferenceImages` assembly, minimally. Both urls were
      // already SSRF-validated above, so fetching them here is safe. A fetch
      // failure degrades silently to no-reference.
      const referenceImages: Array<{ base64: string; mimeType?: string }> = [];
      // Round 10: capture logo + aesthetic ref bytes separately so the mimicry
      // path can pass them as distinct typed inputs (not a flat merged array).
      let regenLogoRef: { base64: string; mimeType: string } | null = null;
      let regenAestheticRef: { base64: string; mimeType: string } | null = null;
      for (const [refUrl, kind] of [[safeLogoUrl, "logo"], [safeAestheticRef, "ref"]] as [string | undefined, string][]) {
        if (!refUrl) continue;
        // SSRF-safe (content-type + redirect:"manual" + byte cap); null → skip.
        const ref = await safeFetchPublicImage(refUrl);
        if (ref) {
          referenceImages.push({ base64: ref.base64, mimeType: ref.mimeType });
          if (kind === "logo") regenLogoRef = { base64: ref.base64, mimeType: ref.mimeType };
          if (kind === "ref") regenAestheticRef = { base64: ref.base64, mimeType: ref.mimeType };
        }
      }

      // R3 parity: cap the headline the same way the main flow does (≤16 words /
      // ≤90 chars) so the regenerated creative's font sizing matches the original
      // (the UI sends `renderedHeadline`, but cap defensively for raw callers too).
      const headline = capHeadline(input.headline.trim());
      const channelName = input.channelName || "Channel";
      // R3 parity: drop a private/internal-host bgImageUrl (SSRF), keep a valid
      // public one as the creative background (the real article photo).
      const safeBgImageUrl =
        input.bgImageUrl && isPublicImageUrl(input.bgImageUrl) ? input.bgImageUrl : undefined;
      // Build the cinematic background prompt the same way the static path does,
      // then append the user's free-text style notes AND the article-context blurb
      // (bgContext) so the AI background reflects the article, not just the
      // headline. Both flow through the same `appendImageContext` channel (capped
      // to 600 by the schema) → sanitized downstream inside generateImageSafe.
      const bgPrompt = appendImageContext(
        `Create a cinematic, high-quality BACKGROUND photo for a social post about:\n\nTopic: "${headline}"\n\nPhotorealistic or editorial illustration, dramatic lighting, strong mood, relevant to the topic.`,
        mergeStyleContext(input.imageContext, input.bgContext),
      );

      // F6: when the user has edited the creative notes (imageContext) since the
      // last render, re-derive the hook line from those notes rather than reusing
      // the original rendered hook verbatim. This makes "Regenerate" honour both
      // the background re-roll AND any updated wording instructions in the notes.
      // Falls back to the client-supplied hookLine (original render) on failure.
      const regenNotes = input.imageContext?.trim() || "";
      let regenHookLine = input.hookLine;
      if (input.creativeStyle === "hook_bars" && regenNotes) {
        const { generateContent } = await import("@postautomation/ai");
        try {
          const rawHook = await generateContent({
            provider: "openai",
            platform: "INSTAGRAM",
            userPrompt: buildHookLinePrompt(headline, regenNotes),
            tone: "professional",
          });
          const trimmed = rawHook.replace(/^["']|["']$/g, "").replace(/\n[\s\S]*$/, "").trim();
          if (trimmed.length > 0) regenHookLine = capHookLine(trimmed);
        } catch {
          // degrade to original hookLine
        }
      }

      // Round 10: mimicry-first path for regenerateImage — mirrors the main flow.
      // Active when the user has referenceMimicry=true AND the aesthetic ref was
      // fetchable. Falls through to renderStaticCreative on engine: "template".
      let regenMimicryEngine: "gemini-img2img" | "openai-described" | null = null;
      let creative: { imageBase64: string; mimeType: string; bgSource?: "ai" | "stock"; imageEngine?: "gemini" | "openai" };
      if (input.referenceMimicry && regenAestheticRef) {
        try {
          const {
            generateReferenceStyledCard,
            overlayHeadlineAndLogo: overlayFn,
            describeImageStyle,
            generateImage: nanoBananaGenerate,
          } = await import("@postautomation/ai");

          // Build heroImage from the safe article bg url if present.
          let heroImage: { base64: string; mimeType: string } | undefined;
          if (safeBgImageUrl) {
            const fetched = await safeFetchPublicImage(safeBgImageUrl).catch(() => null);
            if (fetched) heroImage = { base64: fetched.base64, mimeType: fetched.mimeType };
          }

          const regenDeps: import("@postautomation/ai").ReferenceCardDeps = {
            generateImage: async (params) => {
              // Raw nano-banana provider (NOT generateImageSafe) so Gemini failure
              // throws and the mimicry ladder advances honestly to rung-2.
              const result = await nanoBananaGenerate({
                prompt: params.prompt,
                aspectRatio: params.aspectRatio,
                ...(params.referenceImages ? { referenceImages: params.referenceImages } : {}),
              });
              return { imageBase64: result.imageBase64, mimeType: result.mimeType };
            },
            describeImageStyle: async (base64, mimeType) => describeImageStyle(base64, mimeType),
            generateImageDallE: async (params) => {
              const { generateImageDallE: dallE } = await import("@postautomation/ai");
              const result = await dallE({
                prompt: params.prompt,
                ...(params.size ? { size: params.size as import("@postautomation/ai").DallESize } : {}),
                ...(params.quality ? { quality: params.quality as import("@postautomation/ai").DallEQuality } : {}),
              });
              return { imageBase64: result.imageBase64, mimeType: result.mimeType };
            },
            overlayHeadlineAndLogo: overlayFn,
          };

          const m = await generateReferenceStyledCard(
            {
              referenceImage: regenAestheticRef,
              ...(heroImage ? { heroImage } : {}),
              ...(regenLogoRef ? { logoImage: regenLogoRef } : {}),
              headline,
              brandName: channelName,
              handle: input.channelHandle || channelName,
              brandColor,
              textMode: input.mimicryTextMode,
            },
            regenDeps,
          );

          if (m.engine !== "template" && m.imageBase64) {
            creative = { imageBase64: m.imageBase64, mimeType: m.mimeType || "image/jpeg" };
            regenMimicryEngine = m.engine as "gemini-img2img" | "openai-described";
          } else {
            // Fall through to template path below.
            throw new Error("mimicry engine returned template signal — falling through");
          }
        } catch {
          // Mimicry failed entirely — fall through to renderStaticCreative.
          try {
            creative = await renderStaticCreative({
              ai: { generateImageSafe, generateStyledCreativeImage },
              bgPrompt,
              headline,
              category: "news",
              creativeStyle: input.creativeStyle,
              theme: input.theme,
              channelName,
              handle: input.channelHandle || channelName,
              logoUrl: safeLogoUrl || null,
              logoPosition: input.logoPosition,
              brandColor,
              referenceImages,
              ...(regenHookLine ? { hookLine: regenHookLine } : {}),
              ...(safeBgImageUrl ? { bgImageUrl: safeBgImageUrl } : {}),
            });
          } catch (e) {
            throw toFriendlyAIError(e);
          }
        }
      } else {
        try {
          creative = await renderStaticCreative({
            ai: { generateImageSafe, generateStyledCreativeImage },
            bgPrompt,
            headline,
            category: "news",
            creativeStyle: input.creativeStyle,
            theme: input.theme,
            channelName,
            handle: input.channelHandle || channelName,
            logoUrl: safeLogoUrl || null,
            logoPosition: input.logoPosition,
            brandColor,
            referenceImages,
            ...(regenHookLine ? { hookLine: regenHookLine } : {}),
            ...(safeBgImageUrl ? { bgImageUrl: safeBgImageUrl } : {}),
          });
        } catch (e) {
          throw toFriendlyAIError(e);
        }
      }

      // Upload to S3 + create a Media row (same pattern as the main flow's
      // uploadAndCreateMedia) so the UI can swap + attach the new image.
      const s3 = getS3Client();
      const ext = creative.mimeType.includes("png") ? "png" : "jpg";
      const contentType = creative.mimeType.includes("png") ? "image/png" : "image/jpeg";
      const key = `repurpose/regen-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
      const buf = Buffer.from(creative.imageBase64, "base64");
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: contentType }));
      const url = getPublicUrl(key);
      const media = await ctx.prisma.media.create({
        data: {
          organizationId,
          uploadedById: userId,
          fileName: `regen-${Date.now()}.${ext}`,
          fileType: contentType,
          fileSize: buf.length,
          url,
        },
      });

      // bgSource + imageEngine let the UI refresh the "Image created by X" chip
      // after a regenerate instead of showing the stale engine from the first run.
      // Round 10: also surface which mimicry rung was used (null = template path).
      return { url, mediaId: media.id, bgSource: creative.bgSource === "ai" ? "ai" : "real", imageEngine: creative.imageEngine ?? null, mimicryEngine: regenMimicryEngine };
    }),
});
