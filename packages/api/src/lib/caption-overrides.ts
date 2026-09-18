import { z } from "zod";

/**
 * Manual per-channel captions written in Content Studio Compose (2026-09-18).
 *
 * The user turns on "Different caption per channel" and types a caption for any
 * of the selected channels. Each one is persisted as `PostTarget.contentOverride`
 * at create time — the SAME column the AI caption-fanout worker and the post
 * detail page's per-channel editor already write — so the publish worker's
 * precedence `contentOverride ?? contentVariants?.[platform] ?? post.content`
 * needs no change and a channel without an override publishes the shared caption
 * exactly as before.
 *
 * ⚠️ Byte-identical when unused: absent/empty input ⇒ `sanitizeCaptionOverrides`
 * returns undefined ⇒ the targets are created without a `contentOverride` key,
 * which is the pre-feature write. Never default a key here.
 *
 * Coexists with the AI toggle: caption-fanout skips targets whose
 * contentOverride is already non-null, so a user may hand-write two captions
 * and let the AI generate the rest.
 */

/** Same ceiling as post.updateTargetContent — one rule for one column. */
export const CAPTION_OVERRIDE_MAX = 100_000;

export const captionOverridesSchema = z.record(z.string().max(CAPTION_OVERRIDE_MAX));

/**
 * Keep only overrides that (a) target a channel this post actually has, (b) are
 * non-blank, and (c) differ from the shared caption. A caption identical to the
 * shared one is a no-op override — storing it would make the post page show a
 * "custom caption" that is not custom, and would stop a later shared-caption edit
 * from reaching that channel.
 */
export function sanitizeCaptionOverrides(
  overrides: Record<string, string> | undefined,
  channelIds: string[],
  sharedContent: string
): Record<string, string> | undefined {
  if (!overrides) return undefined;
  const allowed = new Set(channelIds);
  const shared = sharedContent.trim();
  const out: Record<string, string> = {};
  for (const [channelId, caption] of Object.entries(overrides)) {
    if (!allowed.has(channelId)) continue; // not a channel this post targets
    if (typeof caption !== "string") continue;
    const trimmed = caption.trim();
    if (trimmed.length === 0) continue; // blank ⇒ use the shared caption
    if (trimmed === shared) continue; // no-op override
    out[channelId] = caption;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The `contentOverride` a recreated PostTarget should carry when `post.update`
 * replaces a post's channels.
 *
 * ⚠️ `post.update` used to recreate targets with channelId + status + format
 * only, so adding ONE channel from the post detail page silently wiped every
 * per-channel caption on the post — the AI-generated ones and the hand-written
 * ones alike. A KEPT channel keeps exactly what it had; a NEW channel starts
 * with none (the shared caption).
 */
export function contentOverrideForReplacedTarget(
  channelId: string,
  existingTargets: Array<{ channelId: string; contentOverride: string | null }>
): string | null {
  return existingTargets.find((t) => t.channelId === channelId)?.contentOverride ?? null;
}
