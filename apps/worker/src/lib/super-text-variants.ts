import { superTextConfigSchema, type SuperTextConfig } from "@postautomation/super-text";

/**
 * Per-channel super text (2026-10-02) — the pure half.
 *
 * "Unique caption per channel" has a sibling for the burned-in text strip: when a
 * post goes to several channels, AI writes a DIFFERENT strip line for each one,
 * and each channel publishes its own burned video. These helpers build the
 * prompt, parse + sanitize the model's answer, derive a per-variant config from
 * the user's base config, and decide which target gets which variant. No I/O,
 * so the whole contract is unit-tested without ffmpeg, Puppeteer or a model.
 *
 * Cost model, stated plainly: EVERY variant is one more ffmpeg encode on the
 * 4-core prod box (the super-text worker runs them one at a time). So the number
 * of distinct variants is CAPPED (`SUPER_TEXT_MAX_VARIANTS`, default 40): past the
 * cap, channels reuse variants round-robin — still different from their
 * neighbours, never 240 encodes for one post. The user's own text is always
 * variant 0 (the ordinary shared burn), so a channel that falls back still gets
 * the strip the user wrote.
 */

/** Hard ceiling on distinct burns per video; env-tunable. */
export function maxSuperTextVariants(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SUPER_TEXT_MAX_VARIANTS);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return 40;
}

/** Lines per model call — keeps each answer short enough to parse reliably. */
export const SUPER_TEXT_VARIANT_CHUNK = 20;

/** Schema ceiling on a whole strip (packages/super-text schema.ts). */
const STRIP_MAX_CHARS = 150;
/** Schema ceiling on one word/segment. */
const SEGMENT_MAX_CHARS = 60;

/** Join the user's segments back into the line they typed. */
export function baseTextOf(cfg: Pick<SuperTextConfig, "segments">): string {
  return cfg.segments.map((s) => s.text).join(" ");
}

/**
 * How long a variant may be. Anchored on the user's own line (a strip wraps, so a
 * much longer variant lands differently on the frame), with a floor so a 3-word
 * base still leaves room for a real alternative, and the schema cap as ceiling.
 */
export function variantCharLimit(baseText: string): number {
  const len = [...baseText.trim()].length;
  return Math.min(STRIP_MAX_CHARS, Math.max(40, Math.round(len * 1.6)));
}

export interface VariantChannel {
  /** Chunk-local index the model echoes back. */
  index: number;
  platform: string;
  channelName: string;
  username: string | null;
}

export function buildSuperTextVariantPrompt(opts: {
  baseText: string;
  postContent: string;
  channels: VariantChannel[];
  charLimit: number;
}): string {
  const lines = opts.channels
    .map(
      (c) =>
        `${c.index}. platform=${c.platform}, channel="${c.channelName}"${c.username ? ` (@${c.username})` : ""}`
    )
    .join("\n");
  const caption = opts.postContent.trim();
  const hasEmoji = /\p{Extended_Pictographic}/u.test(opts.baseText);

  return `Write ${opts.channels.length} alternative on-video text overlays ("super text") for ONE short social video — one per channel listed below.

The user's own overlay is:
"""
${opts.baseText}
"""
${caption ? `\nThe post caption, for context only (do not copy it):\n"""\n${caption.slice(0, 1500)}\n"""\n` : ""}
Rules:
- Each overlay must carry the SAME hook/meaning as the user's overlay. Do NOT invent facts, names, numbers or claims.
- Every overlay must be clearly DIFFERENT in wording from the user's overlay and from each other.
- One short line each, at most ${opts.charLimit} characters, roughly the length of the user's overlay. Punchy, spoken-language, no hashtags, no quotation marks, no numbering.
- ${hasEmoji ? "Emoji are welcome where they fit (the user's overlay uses them)." : "Do not add emoji — the user's overlay has none."}
- Output ONLY a JSON array — no prose, no markdown fences: [{"index": 0, "text": "..."}, ...] with exactly one item per channel, using each channel's index number.

Channels:
${lines}`;
}

/**
 * Extract the JSON array from raw model output (tolerates fences / surrounding
 * prose). Throws when no array is present; drops malformed items.
 */
export function parseVariantArray(raw: string): Array<{ index: number; text: string }> {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) throw new Error("No JSON array found in model output");
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("Model output is not a JSON array");
  return parsed
    .filter(
      (item): item is { index: unknown; text: string } =>
        !!item && typeof item === "object" && typeof (item as any).text === "string"
    )
    .map((item) => ({
      index: Number((item as any).index),
      // Strip wrapping quotes/whitespace and collapse internal runs — the strip
      // builder splits on whitespace and a stray newline would become a segment.
      text: item.text.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "").replace(/\s+/g, " ").trim(),
    }))
    .filter((item) => Number.isInteger(item.index) && item.index >= 0 && item.text.length > 0);
}

/** Case/punctuation-insensitive key for "is this the same line?". */
export function normalizeVariantText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Keep only usable, DISTINCT lines: within the char limit, not a rewording-free
 * copy of the base or of an earlier variant, and representable as a valid
 * config (every word ≤ 60 chars, whole strip ≤ 150).
 */
export function sanitizeVariantTexts(opts: {
  baseText: string;
  candidates: string[];
  charLimit: number;
  baseCfg: SuperTextConfig;
}): string[] {
  const seen = new Set<string>([normalizeVariantText(opts.baseText)]);
  const out: string[] = [];
  for (const candidate of opts.candidates) {
    const text = candidate.trim();
    if (!text || [...text].length > opts.charLimit) continue;
    const key = normalizeVariantText(text);
    if (!key || seen.has(key)) continue;
    if (!variantConfigFromBase(opts.baseCfg, text)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/**
 * The variant keeps EVERYTHING the user set — position, size, font, strip and text
 * colours — and only swaps the words. Per-word highlight colours are carried by
 * POSITION (the 2nd word stays red if the user's 2nd word was red), which keeps
 * the family of videos visually consistent. Returns null when the text cannot be
 * expressed within the schema.
 */
export function variantConfigFromBase(base: SuperTextConfig, text: string): SuperTextConfig | null {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  if (words.some((w) => w.length > SEGMENT_MAX_CHARS)) return null;
  const segments = words.map((w, i) => {
    const color = base.segments[i]?.color;
    return color ? { text: w, color } : { text: w };
  });
  const parsed = superTextConfigSchema.safeParse({ ...base, segments });
  return parsed.success ? parsed.data : null;
}

/**
 * Which variant each target gets. Index 0 is the user's own text (the shared
 * burn that already repointed PostMedia); 1..N are the AI variants. Round-robin,
 * so with fewer variants than targets, neighbours still differ.
 */
export function assignVariantIndexes(targetCount: number, variantCount: number): number[] {
  const slots = variantCount + 1; // base + variants
  return Array.from({ length: targetCount }, (_, i) => i % slots);
}

/** Variants worth generating for N targets under the cap: never more than N-1. */
export function variantsToGenerate(targetCount: number, cap: number): number {
  if (targetCount <= 1) return 0;
  return Math.max(0, Math.min(targetCount, cap) - 1);
}
