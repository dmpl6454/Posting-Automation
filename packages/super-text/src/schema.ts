import { z } from "zod";
import { SUPER_TEXT_FONT_KEYS, SUPER_TEXT_LAYOUT_KEYS, SUPER_TEXT_SCOPES } from "./constants";

/**
 * Strict #RRGGBB only. Every colour in a SuperTextConfig is interpolated into a
 * `style="…"` attribute by the HTML builder, so anything looser (named colours,
 * `rgb()`, CSS functions) would be a CSS/attribute-injection vector. Mirrors the
 * `safeColor` discipline in packages/ai/src/tools/creative-templates.ts.
 */
const HEX6 = /^#[0-9a-fA-F]{6}$/;

export const superTextSegmentSchema = z.object({
  /** One word/run of the strip. Emoji are ordinary characters here. */
  text: z.string().min(1).max(60),
  /** Optional per-word colour override (Instagram-style highlighted words). */
  color: z.string().regex(HEX6).optional(),
});

export const superTextConfigSchema = z.object({
  version: z.literal(1),
  segments: z
    .array(superTextSegmentSchema)
    .min(1)
    .max(30)
    .refine(
      (segs) => segs.reduce((n, s) => n + s.text.length, 0) <= 150,
      "Super text is limited to 150 characters"
    ),
  /** The pill background (the white strip in the Instagram look). */
  stripColor: z.string().regex(HEX6),
  /** Default text colour for segments with no explicit override. */
  textColor: z.string().regex(HEX6),
  /**
   * Strip anchor — its CENTRE — as a percentage of the video frame. Percentages
   * (not pixels) are what let the compose preview at ~320px wide and the burn at
   * the video's native width place the strip identically.
   */
  xPct: z.number().min(5).max(95),
  yPct: z.number().min(5).max(95),
  /** Font size as a percentage of the video WIDTH (device/resolution independent). */
  fontSizePct: z.number().min(2).max(8),
  /**
   * Which typeface to render. OPTIONAL and deliberately NOT `.default()`: zod's
   * default would INJECT the key, changing JSON.stringify output and therefore
   * the worker's S3 burn-cache hash for every pre-existing config — forcing
   * needless re-burns of already-correct videos. Absent =>
   * resolveSuperTextFont() => "classic", which reproduces the pre-picker CSS
   * exactly.
   */
  font: z.enum(SUPER_TEXT_FONT_KEYS).optional(),
  /**
   * Strip LAYOUT preset (2026-10-02). `insta` reproduces the owner's reference
   * clip: a centred block up to 84% wide, lines LEFT-aligned inside it, a tight
   * line pitch and near-zero vertical padding. OPTIONAL and never `.default()`
   * for exactly the reason `font` is: absent ⇒ the pre-preset geometry,
   * byte-identical, so no existing config re-burns or re-lays-out.
   */
  layout: z.enum(SUPER_TEXT_LAYOUT_KEYS).optional(),
  /**
   * WHERE / HOW LONG the strip shows (2026-10-02, owner decision):
   *   `cover` — composited onto the video's COVER image only (the user's uploaded
   *             cover, else an auto-picked early frame) and set as the post's
   *             videoThumbnail. No video re-encode at all.
   *   `intro` — burned into the first `introSeconds` of the video only.
   *   `video` — burned into every frame (the original behaviour).
   * OPTIONAL, never `.default()`: absent ⇒ `video`, byte-identical for every
   * existing config.
   */
  scope: z.enum(SUPER_TEXT_SCOPES).optional(),
  /** Only read when scope is `intro`. Seconds the strip stays on screen. */
  introSeconds: z.number().min(1).max(30).optional(),
});

export type SuperTextSegment = z.infer<typeof superTextSegmentSchema>;
export type SuperTextConfig = z.infer<typeof superTextConfigSchema>;

/** mediaId → config, as carried in post.create's `metadata.superText`. */
export const superTextMapSchema = z.record(z.string(), superTextConfigSchema);
export type SuperTextMap = z.infer<typeof superTextMapSchema>;
