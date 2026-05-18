/**
 * Safe image generation with prompt sanitization and provider fallback.
 *
 * Google Gemini / Nano Banana frequently blocks images with finishReason
 * `IMAGE_OTHER` when the prompt mentions:
 *   - Named political figures (e.g. "Narendra Modi", "Donald Trump")
 *   - News events involving real people
 *   - Brand-name products / copyrighted characters
 *   - Anything the policy classifier flags as ambiguous
 *
 * This module retries with progressively safer prompts and finally falls
 * back to DALL-E 3 (OpenAI's safety filter has a different — and often
 * more permissive — set of rules for journalistic / topical content).
 *
 * Flow:
 *   attempt 1: original prompt → Gemini
 *   attempt 2: sanitized prompt (proper nouns redacted) → Gemini
 *   attempt 3: generic "thematic illustration" prompt → Gemini
 *   attempt 4: same sanitized prompt → DALL-E 3
 *
 * The caller gets back the first successful image. If every attempt
 * fails, the original error is re-thrown.
 */

import { generateImage as generateNanoBanana, type NanoBananaResult } from "../providers/nano-banana.provider";
import { generateImageDallE } from "../providers/dalle.provider";

export interface SafeImageParams {
  prompt: string;
  aspectRatio?: string;
  title?: string;       // Used to build a topic-only fallback prompt
  topic?: string;       // Optional theme/category for the generic fallback
  referenceImages?: Array<{ base64: string; mimeType?: string }>;
}

export interface SafeImageResult extends NanoBananaResult {
  /** Which provider/attempt produced the image */
  source: "gemini" | "gemini-sanitized" | "gemini-generic" | "dalle";
  /** True if any safety-filter block was encountered before success */
  wasSanitized: boolean;
}

/**
 * Append the universal "no hashtags in the image" rule to every prompt.
 * User preference (memory: no_hashtags_in_image_creatives.md): hashtags
 * belong in the post caption, never baked into the pixels.
 */
const NO_HASHTAG_RULE =
  "\n\nCRITICAL: Do NOT include hashtag text (no #word, no #hashtags) " +
  "anywhere in the image. Hashtags belong in the caption, not the visual.";

export function enforceNoHashtags(prompt: string): string {
  // Avoid double-appending if the caller already includes the rule.
  if (prompt.includes("Do NOT include hashtag")) return prompt;
  return prompt + NO_HASHTAG_RULE;
}

/**
 * Strip names of real people, organizations, and political/sensitive
 * markers from a prompt. Heuristic — not perfect but covers the common
 * Gemini block triggers.
 */
export function sanitizePrompt(prompt: string): string {
  let s = prompt;

  // Remove explicit "subject is X" / "topic is X" / "headline ... X"
  // patterns where X is likely a proper noun (capitalized words).
  // We keep the structural language but strip the named entity.
  s = s.replace(/("|')([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+){0,4})("|')/g, '"the subject"');

  // Replace known sensitive categories with neutral descriptors.
  const replacements: Array<[RegExp, string]> = [
    [/\b(?:Prime Minister|President|Chancellor|Premier|Senator|Governor|Minister|MP|MLA|MLC)\b[^.,;\n]*/gi,
      "a public official"],
    [/\b(?:Bollywood|Hollywood|Tollywood|Kollywood)\s+(?:actor|actress|star|celebrity)\b/gi,
      "an entertainment professional"],
    [/\b(?:cricketer|footballer|tennis player|athlete|sportsperson)\b/gi,
      "a sports figure"],
    [/\b(?:CEO|founder|entrepreneur|billionaire)\s+of\s+[A-Z][\w]+/gi,
      "a business leader"],
    // Remove specific country/political party references
    [/\b(?:BJP|Congress|Republican|Democrat|Tory|Labour|Conservative)\b/gi, "a political party"],
  ];
  for (const [re, rep] of replacements) {
    s = s.replace(re, rep);
  }

  // Strip remaining sequences of 2+ Title-Case words that aren't at the
  // very start of a sentence (likely proper-noun phrases).
  s = s.replace(/(?<=[a-z,;:\s])([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/g, "the subject");

  // Append an explicit safety instruction
  s += "\n\nNote: Depict the theme symbolically and abstractly — do NOT include recognizable real people, logos, or trademarked content.";

  return s;
}

/**
 * Build a fully-generic fallback prompt that depicts only the topic/style
 * without any named entities or specific factual claims.
 */
export function buildGenericPrompt(params: { title?: string; topic?: string; style?: string }): string {
  const theme = params.topic || params.title || "current events";
  const style = params.style || "Professional social media creative with bold typography, modern design, vibrant colors";

  // Abstract the topic to a category — strip everything but generic nouns
  const abstractTheme = theme
    .replace(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g, "")
    .replace(/[^\w\s,.-]/g, "")
    .trim() || "news and current events";

  return `Create an abstract, symbolic social media post illustration on the theme of "${abstractTheme}".

Design style: ${style}

Requirements:
- Abstract, conceptual imagery — no real people, no logos, no specific places
- Symbolic representation of the theme
- Bold visual hierarchy with strong typography
- Vibrant, professional design
- 4:5 portrait aspect ratio
- Suitable for a general audience`;
}

/** Returns true if the error is a safety-filter / content-policy block */
export function isSafetyBlock(err: unknown): boolean {
  const msg = (err as Error)?.message || String(err);
  return /blocked|safety|IMAGE_OTHER|PROHIBITED_CONTENT|SAFETY|content[_\s]?policy|policy_violation/i.test(msg);
}

/**
 * Generate an image with multi-stage fallback. Always returns a result
 * if any attempt succeeds; throws only if all attempts (including DALL-E)
 * fail. Logs each retry so operators can see what's happening.
 */
export async function generateImageSafe(params: SafeImageParams): Promise<SafeImageResult> {
  const { aspectRatio = "1:1", referenceImages } = params;
  // Enforce no-hashtags-in-image on every prompt path. The rule is
  // re-applied after sanitizePrompt and buildGenericPrompt below so the
  // hashtag instruction always survives downstream rewrites.
  const prompt = enforceNoHashtags(params.prompt);
  let lastError: unknown;

  // ── Attempt 1: original prompt via Gemini ──────────────────────────
  try {
    const r = await generateNanoBanana({ prompt, aspectRatio, referenceImages });
    return { ...r, source: "gemini", wasSanitized: false };
  } catch (e) {
    lastError = e;
    if (!isSafetyBlock(e)) {
      // Non-safety failures (network, auth, quota) — try DALL-E directly,
      // skipping the sanitization retries which won't help.
      console.warn(`[safe-image] Gemini failed (non-safety): ${(e as Error).message}. Falling back to DALL-E.`);
      try {
        const dalle = await generateImageDallE({
          prompt,
          size: aspectRatioToDallESize(aspectRatio),
        });
        return { imageBase64: dalle.imageBase64, mimeType: dalle.mimeType, text: dalle.text, source: "dalle", wasSanitized: false };
      } catch (de) {
        throw e; // Re-throw original Gemini error
      }
    }
    console.warn(`[safe-image] Gemini blocked (IMAGE_OTHER / safety). Retrying with sanitized prompt...`);
  }

  // ── Attempt 2: sanitized prompt via Gemini ─────────────────────────
  try {
    const safePrompt = enforceNoHashtags(sanitizePrompt(prompt));
    const r = await generateNanoBanana({ prompt: safePrompt, aspectRatio, referenceImages });
    return { ...r, source: "gemini-sanitized", wasSanitized: true };
  } catch (e) {
    lastError = e;
    if (!isSafetyBlock(e)) {
      console.warn(`[safe-image] Sanitized Gemini retry failed (non-safety): ${(e as Error).message}`);
    } else {
      console.warn(`[safe-image] Sanitized Gemini retry blocked. Trying generic prompt...`);
    }
  }

  // ── Attempt 3: generic prompt via Gemini ───────────────────────────
  try {
    const genericPrompt = enforceNoHashtags(buildGenericPrompt({ title: params.title, topic: params.topic }));
    // Reference images (logos) often retain branding info — drop them here.
    const r = await generateNanoBanana({ prompt: genericPrompt, aspectRatio });
    return { ...r, source: "gemini-generic", wasSanitized: true };
  } catch (e) {
    lastError = e;
    console.warn(`[safe-image] Generic Gemini failed: ${(e as Error).message}. Falling back to DALL-E.`);
  }

  // ── Attempt 4: DALL-E with sanitized prompt ────────────────────────
  try {
    const safePrompt = enforceNoHashtags(sanitizePrompt(prompt));
    const dalle = await generateImageDallE({
      prompt: safePrompt,
      size: aspectRatioToDallESize(aspectRatio),
    });
    return { imageBase64: dalle.imageBase64, mimeType: dalle.mimeType, text: dalle.text, source: "dalle", wasSanitized: true };
  } catch (e) {
    console.error(`[safe-image] All providers failed. Last error: ${(e as Error).message}`);
    throw lastError ?? e;
  }
}

function aspectRatioToDallESize(ratio: string): "1024x1024" | "1024x1792" | "1792x1024" {
  // DALL-E 3 only supports three sizes. Map close ratios.
  if (ratio === "16:9" || ratio === "3:2" || ratio === "21:9") return "1792x1024";
  if (ratio === "9:16" || ratio === "2:3" || ratio === "3:4" || ratio === "4:5") return "1024x1792";
  return "1024x1024";
}
