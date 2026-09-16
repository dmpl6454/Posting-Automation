/**
 * Facebook Page Story helpers (2026-09-16).
 *
 * Facebook publishes a Page story in two hops: the media is uploaded FIRST
 * (unpublished photo, or a video upload session) and only then turned into a
 * story. That intermediate media id is the story's identity for us, exactly as
 * the container id is on Instagram — and for the same reason.
 *
 * 🔴 WHY A CHECKPOINT AT ALL. Facebook's normal publish recovers a lost
 * acknowledgement by listing `published_posts` and matching the CAPTION. A story
 * has no caption, and stories are not on that edge, so that guard is useless
 * here. Without something else, a retry would upload again and publish a SECOND
 * story — the 2026-08-18 duplicate-post incident reached through a new door. So
 * the media id is checkpointed BEFORE the story is created, and a retry asks
 * `GET /{page-id}/stories` whether a story already carries THAT media id.
 *
 * ⚠️ The match is on OUR media id, never on "a story appeared recently". These
 * Pages post stories from the phone constantly, and one Page can be connected to
 * several organisations; adopting by recency would record someone else's story
 * as ours and the user's would never go out.
 */

export type FbStoryKind = "PHOTO" | "VIDEO";

export interface FbStoryCheckpoint {
  /** Unpublished photo id, or the video upload session's video id. */
  id: string;
  kind: FbStoryKind;
  /** True creation time — drives the media's usable lifetime. */
  createdAt: string;
}

/**
 * Facebook deletes an unpublished photo after about 24 hours: "If you do not
 * publish these photos within 24 hours, we delete them." After that the id is
 * useless and a fresh upload is the only way forward.
 */
export const FB_STORY_MEDIA_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How many pages of `GET /{page-id}/stories` to walk before giving up.
 *
 * ⚠️ Running out of pages is NOT "nothing was published" — the caller throws,
 * because these Pages post stories from the phone all day and a diluted listing
 * must never license a second publish.
 */
export const FB_STORY_LIST_MAX_PAGES = 3;

export function readFbStoryCheckpoint(
  metadata: Record<string, unknown> | undefined | null
): FbStoryCheckpoint | null {
  const raw = (metadata as { fbStoryMedia?: unknown } | null | undefined)?.fbStoryMedia;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { id, kind, createdAt } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !id) return null;
  if (kind !== "PHOTO" && kind !== "VIDEO") return null;
  return { id, kind, createdAt: typeof createdAt === "string" ? createdAt : new Date(0).toISOString() };
}

/** Has the uploaded-but-unpublished media aged out of Facebook's 24h window? */
export function isFbStoryMediaExpired(checkpoint: FbStoryCheckpoint, now: Date = new Date()): boolean {
  const created = new Date(checkpoint.createdAt).getTime();
  if (!Number.isFinite(created)) return true;
  return now.getTime() - created > FB_STORY_MEDIA_TTL_MS;
}

export interface FbStoryListEntry {
  post_id?: unknown;
  media_id?: unknown;
  url?: unknown;
  status?: unknown;
  creation_time?: unknown;
  media_type?: unknown;
}

export interface FbStoryMatch {
  postId: string;
  url: string | null;
}

/**
 * Find the story made from OUR uploaded media in a `GET /{page-id}/stories` page.
 *
 * Returns null when the listing is readable and simply does not contain it —
 * which is the evidence that nothing was published yet.
 */
export function findFbStoryByMediaId(
  entries: FbStoryListEntry[] | undefined | null,
  mediaId: string
): FbStoryMatch | null {
  for (const entry of entries ?? []) {
    if (String(entry?.media_id ?? "") !== mediaId) continue;
    const postId = String(entry?.post_id ?? "");
    if (!postId) continue;
    const url = typeof entry?.url === "string" && /^https?:\/\//i.test(entry.url) ? entry.url : null;
    return { postId, url };
  }
  return null;
}

/**
 * Viewable URL for a published Page story.
 *
 * Prefer the `url` the API itself returns; this is only the fallback, and it
 * matches the shape Meta documents (`https://facebook.com/stories/{id}`).
 */
export function fbStoryUrl(postId: string): string {
  return `https://www.facebook.com/stories/${postId}`;
}

/**
 * Does this Graph error mean the Page holder cannot publish content?
 *
 * Page stories need the CREATE_CONTENT task, which nothing in our connect flow
 * verifies — a Page connected by someone with only a moderator role publishes
 * feed posts but fails here. The generic "story publish failed" text sends the
 * operator hunting a media problem, so it is named.
 */
export function isFbPermissionError(body: unknown): boolean {
  const err = (body as { error?: { code?: unknown; message?: unknown } } | null | undefined)?.error;
  if (!err) return false;
  const code = Number(err.code);
  const message = String(err.message ?? "").toLowerCase();
  if (code === 200 || code === 10) return true;
  return /permission|not authorized|create_content|insufficient/i.test(message);
}
