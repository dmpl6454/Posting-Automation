/**
 * Instagram STORIES publishing helpers (2026-09-15).
 *
 * A story is an ordinary media container with `media_type: "STORIES"`. The
 * Content Publishing API accepts `user_tags=[{username}]` on image AND video
 * story containers ("Required for user tagging in images, videos, and stories";
 * x/y are optional for stories, and sticker-less mentions are explicitly
 * supported while link/poll/location stickers are not).
 *
 * Everything here is PURE so the provider's request shape and its
 * duplicate-prevention decisions can be unit-tested without the network.
 *
 * ⚠️ Absent story metadata must leave every provider call byte-identical — the
 * IG publish path is contractually frozen. Every helper therefore returns
 * null / false / "none" for non-story input.
 *
 * ── Why the CONTAINER, not the caption, is a story's identity ────────────────
 * The feed path recovers a lost `media_publish` acknowledgement by listing the
 * account and matching the CAPTION (`findPublishedMatch`). A story has no
 * caption to match on, and `GET /{ig-user}/media` does not list stories at all.
 * Matching "a story appeared in the last N seconds" instead would adopt a story
 * the user posted from the phone, or one published by the SAME IG account
 * connected to a different organization — recording a foreign id as ours and
 * silently never publishing the user's story.
 *
 * The container is the real key: Meta's container `status_code` becomes
 * `PUBLISHED` once `media_publish` has consumed it, and a container is
 * single-use, so re-sending `media_publish` with the same `creation_id` can
 * never create a second story. We therefore persist the container id the moment
 * it is created (see `onCheckpoint` in SocialPostPayload) and, on any retry, ask
 * Meta what happened to THAT container before writing anything.
 */

/** Instagram username charset: letters, digits, dot, underscore; 1–30 chars. */
export const IG_USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;

/** Cap on mentions per story — mirrors the caption @-tag limit Meta documents. */
export const STORY_MAX_MENTIONS = 20;

/** Media kinds a story can carry; matches IG Media `media_type` for stories. */
export type StoryMediaKind = "IMAGE" | "VIDEO";

/** The checkpoint the provider persists before it publishes a story container. */
export interface StoryContainerCheckpoint {
  /** Meta container id (`creation_id`). */
  id: string;
  /** ISO timestamp of container creation — the floor for identifying the media. */
  createdAt: string;
  kind: StoryMediaKind;
}

/**
 * True when this target publishes as a STORY. Covers BOTH routes into a story:
 * Compose's Story mode (which forces `format: "STORY"` on every target) and the
 * pre-existing per-channel Reel/Story picker for videos.
 */
export function isStoryFormat(metadata: Record<string, unknown> | undefined | null): boolean {
  return String((metadata as { format?: unknown } | null | undefined)?.format ?? "").toUpperCase() === "STORY";
}

/**
 * True only for Compose's STORY MODE (the post carries `metadata.instagramStory`).
 *
 * ⚠️ Deliberately distinct from `isStoryFormat`. The per-channel picker also
 * yields `format: "STORY"`, and that pre-existing path must keep its current
 * behaviour for multi-media posts (it publishes a carousel). Only story MODE —
 * where the product promises "one image or video" — refuses them.
 */
export function isStoryModePost(metadata: Record<string, unknown> | undefined | null): boolean {
  const v = (metadata as { instagramStory?: unknown } | null | undefined)?.instagramStory;
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Usernames from `metadata.instagramStory.mentions`, cleaned: leading `@`
 * stripped, malformed entries dropped, case-insensitive dedupe (first spelling
 * wins), capped at STORY_MAX_MENTIONS.
 *
 * Defense in depth — post.create runs the same validation, but this value comes
 * back OUT of the database and is interpolated into a Graph request body.
 */
export function readStoryMentions(metadata: Record<string, unknown> | undefined | null): string[] {
  const raw = (metadata as { instagramStory?: { mentions?: unknown } } | null | undefined)?.instagramStory?.mentions;
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
    if (out.length >= STORY_MAX_MENTIONS) break;
  }
  return out;
}

/**
 * The `user_tags` value for a STORIES container, or null when there is nothing
 * to send (so an untagged story's request stays byte-identical).
 *
 * Sent as a real JSON array inside the JSON body — the same transport shape the
 * carousel path already uses for `children`.
 */
export function buildStoryUserTags(
  metadata: Record<string, unknown> | undefined | null
): Array<{ username: string }> | null {
  const mentions = readStoryMentions(metadata);
  return mentions.length > 0 ? mentions.map((username) => ({ username })) : null;
}

function safeUsername(username: unknown): string | null {
  const u = typeof username === "string" ? username.trim().replace(/^@/, "") : "";
  return IG_USERNAME_RE.test(u) ? u : null;
}

/**
 * The account's story tray. Used when the specific media id could not be
 * identified but the story IS live — an honest destination beats a fabricated
 * media URL.
 */
export function storyTrayUrl(username: unknown): string {
  const u = safeUsername(username);
  return u ? `https://www.instagram.com/stories/${u}/` : "https://www.instagram.com/";
}

/**
 * Story URL when Meta returns no `permalink`. `/p/{id}` is a 404 for stories,
 * so fall back to the account's stories path — and to the site root when the
 * username is unusable. Never interpolate an unvalidated value into a URL.
 */
export function storyPermalinkFallback(username: unknown, mediaId: string): string {
  const u = safeUsername(username);
  if (!u || !/^\d+$/.test(mediaId)) return storyTrayUrl(username);
  return `https://www.instagram.com/stories/${u}/${mediaId}/`;
}

export type StoryCandidate =
  | { outcome: "match"; story: { id: string; permalink?: string } }
  | { outcome: "none" }
  | { outcome: "many"; count: number };

/**
 * Identify OUR story among the account's live stories, given that the container
 * has already told us the story exists.
 *
 * ⚠️ This is an IDENTIFICATION step, never an existence proof. It runs only
 * after `classifyContainerStatus` returned "published"; calling it to decide
 * WHETHER a story published would adopt a story someone else posted in the same
 * window (the account posts stories constantly, and the same IG account can be
 * connected to several organizations).
 *
 * Exactly one candidate ⇒ that is ours. Zero or several ⇒ the caller keeps the
 * container id and reports the story as published-but-unresolved rather than
 * guessing.
 */
export function pickStoryCandidate(
  rows: Array<{ id?: unknown; timestamp?: unknown; media_type?: unknown; permalink?: unknown } | null | undefined>,
  since: Date,
  kind: StoryMediaKind
): StoryCandidate {
  const matches: Array<{ id: string; permalink?: string }> = [];
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || typeof row.timestamp !== "string") continue;
    const when = new Date(row.timestamp);
    if (Number.isNaN(when.getTime()) || when.getTime() < since.getTime()) continue;
    if (String(row.media_type ?? "").toUpperCase() !== kind) continue;
    matches.push({
      id: row.id,
      ...(typeof row.permalink === "string" && row.permalink ? { permalink: row.permalink } : {}),
    });
  }
  if (matches.length === 1) return { outcome: "match", story: matches[0]! };
  if (matches.length === 0) return { outcome: "none" };
  return { outcome: "many", count: matches.length };
}

/** Read a persisted container checkpoint, or null when there is none / it is malformed. */
export function readStoryContainerCheckpoint(
  metadata: Record<string, unknown> | undefined | null
): StoryContainerCheckpoint | null {
  const raw = (metadata as { igStoryContainer?: unknown } | null | undefined)?.igStoryContainer;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { id, createdAt, kind } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !id) return null;
  if (typeof createdAt !== "string" || Number.isNaN(new Date(createdAt).getTime())) return null;
  if (kind !== "IMAGE" && kind !== "VIDEO") return null;
  return { id, createdAt, kind };
}

export type ContainerDisposition =
  /** media_publish already consumed it — the story IS live. Never create another. */
  | "published"
  /** Still usable: publish THIS container instead of creating a second one. */
  | "reusable"
  /** Unusable (errored/expired/gone) — creating a fresh container is safe. */
  | "dead";

/**
 * Classify a container `status_code` for reuse decisions.
 *
 * ⚠️ An UNKNOWN status is "reusable", not "dead". Creating a second container is
 * the expensive mistake (a duplicate story on a live audience); publishing a
 * container that turns out to be unusable merely fails the attempt, which the
 * ordinary retry path already handles.
 */
export function classifyContainerStatus(statusCode: unknown): ContainerDisposition {
  const s = String(statusCode ?? "").toUpperCase();
  if (s === "PUBLISHED") return "published";
  if (s === "ERROR" || s === "EXPIRED") return "dead";
  return "reusable";
}

/**
 * Does this Graph error say a `user_tags` username is unusable (private,
 * non-existent, or not taggable)?
 *
 * Worth recognising because it fails the container creation for EVERY selected
 * channel at once, and the generic "Instagram media container creation failed"
 * text sends the operator looking for a media problem. Pre-write, so it is
 * duplicate-safe — the remedy is to drop the tag and retry.
 */
export function isUserTagRejection(errorBody: unknown): boolean {
  const err = (errorBody as { error?: Record<string, unknown> } | null | undefined)?.error;
  if (!err) return false;
  const message = `${String(err.message ?? "")} ${String(err.error_user_msg ?? "")} ${String(err.error_user_title ?? "")}`;
  if (!message.trim()) return false;
  return /user[_ ]?tag|tagged? user|username|not a valid user|cannot be tagged|does not exist/i.test(message);
}
