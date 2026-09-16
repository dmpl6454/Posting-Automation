/**
 * Pure helpers for Content Studio → Compose's Instagram Story mode (2026-09-15).
 *
 * No React, no tRPC — so channel filtering, group behaviour, mention parsing and
 * the submit gate are unit-tested, and the component only wires them together.
 *
 * ⚠️ `IG_USERNAME_RE` is a deliberate replica of the rule in `packages/api` and
 * `packages/social`. The browser bundle must not pull in a server package for one
 * regex, and both server layers re-validate anyway. Keep the three in step.
 */

export type PostType = "post" | "story";

export const IG_USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
export const STORY_MAX_MENTIONS = 20;

export function isInstagramChannel(channel: { platform: string }): boolean {
  return channel.platform === "INSTAGRAM";
}

/**
 * Platforms a story can publish to (2026-09-16: Facebook Page stories added).
 *
 * ⚠️ Tagging stays INSTAGRAM-ONLY — Meta's Page Stories API documents no tag or
 * mention parameter, so a tag cannot reach a Facebook story at all.
 */
export const STORY_PLATFORMS = ["INSTAGRAM", "FACEBOOK"] as const;

export function isStoryChannel(channel: { platform: string }): boolean {
  return (STORY_PLATFORMS as readonly string[]).includes(channel.platform);
}

/** In Story mode only Instagram and Facebook channels are selectable; Post mode is untouched. */
export function storySelectableChannels<T extends { platform: string }>(
  channels: T[] | undefined | null,
  postType: PostType
): T[] {
  const list = channels ?? [];
  return postType === "story" ? list.filter(isStoryChannel) : list;
}

/**
 * Drop every selected id that is not a live story-capable channel.
 *
 * Runs on the mode switch AND whenever the channel list resolves — a restored
 * draft, or a group cache that lags a platform change, can otherwise leave a
 * Facebook id selected while the picker shows only Instagram, and the post fails
 * server-side AFTER the media upload.
 */
export function pruneSelectionForStory(
  selectedIds: string[],
  channels: Array<{ id: string; platform: string }>
): { next: string[]; removed: number } {
  const storyIds = new Set(channels.filter(isStoryChannel).map((c) => c.id));
  const next = selectedIds.filter((id) => storyIds.has(id));
  return { next, removed: selectedIds.length - next.length };
}

/**
 * The ids a Groups pill acts on.
 *
 * Post mode keeps today's rule (active members still present in the live channel
 * list). Story mode additionally keeps only story-capable members (Instagram and
 * Facebook Pages), so one click can never pull a YouTube or X channel into a
 * story — and a group with none shows no pill at all rather than a pill that
 * does nothing.
 */
export function groupSelectableIds(
  group: { channels?: Array<{ id: string; platform: string; isActive: boolean }> | null },
  liveIds: Set<string>,
  postType: PostType
): string[] {
  return (group.channels ?? [])
    .filter((c) => c.isActive && liveIds.has(c.id))
    .filter((c) => postType === "post" || isStoryChannel(c))
    .map((c) => c.id);
}

/**
 * Merge freshly typed usernames into the existing list. Splits on commas and
 * whitespace, strips a leading `@`, dedupes case-insensitively against what is
 * already there, names invalid entries and counts anything the cap dropped.
 */
export function addMentions(
  existing: string[],
  raw: string
): { mentions: string[]; invalid: string[]; dropped: number } {
  const mentions = [...existing];
  const seen = new Set(existing.map((m) => m.toLowerCase()));
  const invalid: string[] = [];
  let dropped = 0;
  for (const token of raw.split(/[\s,]+/)) {
    const username = token.trim().replace(/^@/, "");
    if (!username) continue;
    if (!IG_USERNAME_RE.test(username)) {
      invalid.push(token.trim());
      continue;
    }
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    if (mentions.length >= STORY_MAX_MENTIONS) {
      dropped++;
      continue;
    }
    seen.add(key);
    mentions.push(username);
  }
  return { mentions, invalid, dropped };
}

/**
 * Re-validate a mentions list restored from localStorage.
 *
 * A draft written by an older build, or hand-edited storage, must never reach
 * post.create — one bad username there rejects the ENTIRE post, which is the
 * failure shape the super-text and cover restore paths already guard against.
 */
export function sanitizeRestoredMentions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  // ⚠️ Validated ENTRY BY ENTRY, deliberately not by re-running the typed-input
  // splitter over a joined string: a stored "bad name" is ONE malformed entry,
  // and splitting it would silently resurrect it as two valid-looking mentions
  // that tag the wrong accounts.
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const username = item.trim().replace(/^@/, "");
    if (!IG_USERNAME_RE.test(username)) continue;
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    if (out.length >= STORY_MAX_MENTIONS) break;
    seen.add(key);
    out.push(username);
  }
  return out;
}

/** Why the story cannot be submitted right now, or null when it can. */
export function storyBlockReason(input: {
  mediaCount: number;
  selectedCount: number;
  uploading: boolean;
}): string | null {
  if (input.uploading) return "Media is still uploading.";
  if (input.mediaCount === 0) return "Attach one image or video for your story.";
  if (input.mediaCount > 1) {
    const extra = input.mediaCount - 1;
    return `A story takes exactly one image or video — remove ${extra} attachment${extra === 1 ? "" : "s"}.`;
  }
  if (input.selectedCount === 0) return "Select at least one Instagram or Facebook channel.";
  return null;
}
