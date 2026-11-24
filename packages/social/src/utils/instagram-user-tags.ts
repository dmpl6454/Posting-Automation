/**
 * Tagging people on Instagram FEED posts and REELS (2026-11-24).
 *
 * Meta's IG Media reference (v27.0) lists `user_tags` on Image containers, Reel
 * containers and story containers: "Required for user tagging in images, videos,
 * and stories." The x/y coordinates are "Required for images, optional for
 * stories", must be within 0.0–1.0, and apply only to images and stories — so a
 * reel sends bare usernames, a photo sends usernames WITH positions.
 *
 * Carousels: the parent CAROUSEL container does not list `user_tags`, but each
 * child is an ordinary Image container, which does. Tags therefore go on the
 * first PHOTO child. A carousel of only videos gets no tags (the docs give video
 * children no tag shape), and that is logged rather than guessed.
 *
 * Stored on `Post.metadata.instagramUserTags = { usernames }`, written ONLY by
 * post.create's `instagramTags` input (the raw client key is stripped). Story
 * mode keeps its own `metadata.instagramStory.mentions`.
 *
 * ⚠️ Absent tags must leave every container request byte-identical — every
 * helper returns null for untagged input.
 */

import { IG_USERNAME_RE, STORY_MAX_MENTIONS } from "./instagram-story";

/** Same cap as stories: Meta documents 20 @-tags per caption. */
export const POST_MAX_USER_TAGS = STORY_MAX_MENTIONS;

function cleanUsernames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const username = item.trim().replace(/^@/, "");
    if (!IG_USERNAME_RE.test(username)) continue;
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(username);
    if (out.length >= POST_MAX_USER_TAGS) break;
  }
  return out;
}

/**
 * Usernames from `metadata.instagramUserTags.usernames`, re-validated: this
 * value comes back OUT of the database and is placed in a Graph request body.
 */
export function readPostUserTags(metadata: Record<string, unknown> | undefined | null): string[] {
  const raw = (metadata as { instagramUserTags?: { usernames?: unknown } } | null | undefined)?.instagramUserTags
    ?.usernames;
  return cleanUsernames(raw);
}

/**
 * Where tag N of `count` sits on a photo. Instagram requires a position for a
 * photo tag; Compose has no "tap where the person is" picker, so tags are laid
 * out in a centred grid (max 3 per row) where they do not overlap. Positions
 * are rounded to two decimals and always inside 0.05–0.95.
 */
export function imageTagPosition(index: number, count: number): { x: number; y: number } {
  const cols = Math.min(Math.max(count, 1), 3);
  const rows = Math.ceil(Math.max(count, 1) / 3);
  const col = index % 3;
  const row = Math.floor(index / 3);
  const round = (v: number) => Math.min(0.95, Math.max(0.05, Math.round(v * 100) / 100));
  return { x: round((col + 1) / (cols + 1)), y: round((row + 1) / (rows + 1)) };
}

/** `user_tags` for a REELS container (no positions), or null when untagged. */
export function buildReelUserTags(
  metadata: Record<string, unknown> | undefined | null
): Array<{ username: string }> | null {
  const tags = readPostUserTags(metadata);
  return tags.length > 0 ? tags.map((username) => ({ username })) : null;
}

/** `user_tags` for a photo (feed image or carousel photo), or null when untagged. */
export function buildImageUserTags(
  metadata: Record<string, unknown> | undefined | null
): Array<{ username: string; x: number; y: number }> | null {
  const tags = readPostUserTags(metadata);
  if (tags.length === 0) return null;
  return tags.map((username, i) => ({ username, ...imageTagPosition(i, tags.length) }));
}

/** "@a, @b" — for error messages that name the tags. */
export function formatTagList(usernames: string[]): string {
  return usernames.map((u) => `@${u}`).join(", ");
}
