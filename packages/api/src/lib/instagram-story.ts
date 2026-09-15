import { z } from "zod";

/**
 * Server-side rules for Instagram Story posts (2026-09-15) and for the
 * per-channel post-format map they share a column with.
 *
 * ⚠️ `IG_USERNAME_RE` is a deliberate REPLICA of the rule in
 * `packages/social/src/utils/instagram-story.ts` (and a third copy lives in
 * `apps/web/lib/instagram-story.ts`). The api package must not pull in the
 * provider bundle for one regex, and the provider re-validates whatever comes
 * back out of the database anyway. Keep the three in step.
 */
export const IG_USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
export const STORY_MAX_MENTIONS = 20;

/** Raw client input, bounded so a hostile payload cannot be large. */
export const storyInputSchema = z.object({
  mentions: z.array(z.string().max(64)).max(50).default([]),
});
export type StoryInput = z.infer<typeof storyInputSchema>;

/**
 * `invalid` = entries that fail the username rule. `dropped` = well-formed
 * entries past the cap. Kept apart so a valid username is never reported as
 * "not a valid Instagram username" just because it was the 21st.
 */
export function normalizeStoryMentions(raw: string[]): { mentions: string[]; invalid: string[]; dropped: number } {
  const mentions: string[] = [];
  const invalid: string[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const item of raw) {
    const username = item.trim().replace(/^@/, "");
    if (!username) continue;
    if (!IG_USERNAME_RE.test(username)) {
      invalid.push(item.trim());
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
 * Returns an actionable message, or null when the story post is valid.
 *
 * `scheduling` = this post will actually publish (a scheduledAt is set, or it is
 * being armed via update / publishNow / bulk schedule). A DRAFT may be saved with
 * no media so the user can attach later — but never with two, because "which one
 * is the story?" has no answer.
 */
export function validateStoryPost(input: {
  channels: Array<{ id: string; platform: string; name?: string | null }>;
  mediaCount: number;
  scheduling: boolean;
}): string | null {
  const foreign = input.channels.filter((c) => c.platform !== "INSTAGRAM");
  if (foreign.length > 0) {
    const names = foreign.map((c) => c.name || c.id).join(", ");
    return `Stories can only be published to Instagram channels. Remove: ${names}.`;
  }
  if (input.mediaCount > 1) {
    return (
      `A story takes exactly one image or video — this post has ${input.mediaCount} attachments. ` +
      `Remove the extras, or switch to a normal post.`
    );
  }
  if (input.scheduling && input.mediaCount === 0) {
    return "Attach one image or video to publish a story.";
  }
  return null;
}

/** Is this post an Instagram Story post? Reads the marker post.create writes. */
export function isStoryModeMetadata(metadata: unknown): boolean {
  const v = (metadata as { instagramStory?: unknown } | null | undefined)?.instagramStory;
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Formats each platform's provider actually understands. */
const FORMATS_BY_PLATFORM: Record<string, ReadonlySet<string>> = {
  INSTAGRAM: new Set(["FEED", "REEL", "STORY", "CAROUSEL"]),
  YOUTUBE: new Set(["SHORT", "VIDEO"]),
};

/** Formats that are meaningless without a video attachment. */
const VIDEO_ONLY_FORMATS = new Set(["REEL", "SHORT", "VIDEO"]);

/**
 * Filter a client-supplied `formatByChannelId` down to entries that can be true.
 *
 * ⚠️ Why this exists. Compose's per-channel picker has exactly ONE setter and is
 * never pruned — not when a channel is deselected, not when the video is removed,
 * not when the picker itself disappears. The whole map is sent whenever it is
 * non-empty. Before Instagram stories that was harmless, because the provider's
 * IMAGE branch ignored `format` entirely. Now `STORY` changes what gets
 * published, so this sequence would post an image STORY from a normal post:
 *
 *   attach video → pick "Story" for an IG channel → remove the video →
 *   attach an image → Publish
 *
 * Entries are DROPPED, not rejected: the user never asked for that format, so
 * falling back to the default (null) is the outcome they expect, whereas an error
 * would be about a control they can no longer even see.
 *
 * Story MODE does not come through here at all — it forces STORY on every target.
 */
export function sanitizeFormatByChannelId(
  formatByChannelId: Record<string, string> | undefined,
  channels: Array<{ id: string; platform: string }>,
  hasVideo: boolean
): Record<string, string> | undefined {
  if (!formatByChannelId) return undefined;
  const platformById = new Map(channels.map((c) => [c.id, c.platform]));
  const out: Record<string, string> = {};
  for (const [channelId, format] of Object.entries(formatByChannelId)) {
    const platform = platformById.get(channelId);
    if (!platform) continue; // not a channel this post targets
    if (!FORMATS_BY_PLATFORM[platform]?.has(format)) continue; // wrong platform
    if (!hasVideo && VIDEO_ONLY_FORMATS.has(format)) continue; // stale video format
    if (!hasVideo && format === "STORY") continue; // stale picker value on an image post
    out[channelId] = format;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The `format` a recreated PostTarget should carry when `post.update` replaces a
 * post's channels.
 *
 * ⚠️ `post.update` used to drop `format` for EVERY target: it selected only
 * `channelId` and recreated rows with `channelId` + `status`. So adding one
 * channel from the post detail page silently re-targeted a Story as a REEL
 * (the provider's default when no format is present).
 *
 * A KEPT channel keeps EXACTLY what it had — never an inferred upgrade. A null
 * there is the user's choice (the picker's default is Reel), and promoting it to
 * STORY would silently turn a Reel into a 24-hour story. Only a NEW channel gets
 * a default, and only on a story-MODE post, where every target is STORY anyway.
 *
 * @param isStoryModePost the `metadata.instagramStory` marker — NOT "some target
 *   happens to be STORY", which is also true of per-channel picker posts.
 */
export function formatForReplacedTarget(
  channelId: string,
  existingTargets: Array<{ channelId: string; format: string | null }>,
  isStoryModePost: boolean
): string | null {
  const kept = existingTargets.find((t) => t.channelId === channelId);
  if (kept) return kept.format;
  return isStoryModePost ? "STORY" : null;
}
