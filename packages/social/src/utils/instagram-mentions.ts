/**
 * Instagram @mentions + new comments on our own media (2026-10-17).
 *
 * Three writes, all AS the connected professional account:
 *   1. a new top-level comment on our own post  — POST /{ig-media-id}/comments
 *   2. the automatic "first comment" after publish — same edge
 *   3. a reply where someone else @mentioned us  — POST /{ig-user-id}/mentions
 *        (media_id + optional comment_id; caption mentions get a comment on
 *        that media, comment mentions a reply under that comment)
 *
 * Permissions (Facebook-Login path): instagram_basic, instagram_manage_comments,
 * pages_read_engagement (+ pages_show_list for comment-mention replies).
 * Mentions are only DISCOVERED through the `mentions` webhook field, which
 * additionally needs pages_manage_metadata and the Page subscribed to the app
 * (POST /{page-id}/subscribed_apps). There is no "list my mentions" endpoint.
 *
 * Meta's limits: no mentions on stories, nothing from private accounts, and
 * no commenting on photos you were merely TAGGED in.
 *
 * Pure helpers only — the Graph calls live in instagram.provider.ts.
 */

import { GRAPH_OBJECT_ID_RE } from "./instagram-comments";

/** Instagram's caption/comment ceiling. */
export const IG_COMMENT_MAX_LENGTH = 2200;

/** A new comment's outcome is unknown — must read as "may already be posted" (the UI keys on that phrase). */
export const COMMENT_CREATE_UNCONFIRMED_MESSAGE =
  "Instagram accepted the comment but did not confirm it. Refresh the comments before posting again — it may already be posted.";
export const COMMENT_CREATE_FAILED_MESSAGE =
  "Instagram couldn't post that comment right now. Please try again in a moment.";

export const MENTION_REPLY_UNCONFIRMED_MESSAGE =
  "Instagram accepted the reply but did not confirm it. Check the post on Instagram before replying again — it may already be posted.";
export const MENTION_REPLY_FAILED_MESSAGE =
  "Instagram couldn't post that reply right now. Please try again in a moment.";
export const MENTION_GONE_MESSAGE =
  "That post or comment is no longer available on Instagram — it may have been deleted, or its owner made the account private or turned comments off.";

/** One mention as Meta's webhook announces it. */
export interface InstagramMentionEvent {
  /** Our professional account's IG user id (entry.id). */
  igUserId: string;
  /** The media the mention is on (someone else's post). */
  mediaId: string;
  /** Present for a comment mention; absent for a caption mention. */
  commentId: string | null;
  /** When Meta sent it (entry.time, seconds). */
  sentAt: Date | null;
}

const isId = (v: unknown): v is string => typeof v === "string" && GRAPH_OBJECT_ID_RE.test(v);

/**
 * Pull every well-formed `mentions` change out of an Instagram webhook payload.
 * Ids that don't look like Graph ids are dropped — they later reach a URL path.
 */
export function parseMentionWebhook(payload: unknown): InstagramMentionEvent[] {
  const p = payload as { object?: unknown; entry?: unknown } | null;
  if (!p || p.object !== "instagram" || !Array.isArray(p.entry)) return [];
  const out: InstagramMentionEvent[] = [];
  for (const entry of p.entry as any[]) {
    if (!entry || !isId(entry.id) || !Array.isArray(entry.changes)) continue;
    const sentAt = typeof entry.time === "number" && Number.isFinite(entry.time) ? new Date(entry.time * 1000) : null;
    for (const change of entry.changes) {
      if (change?.field !== "mentions") continue;
      const v = change.value ?? {};
      if (!isId(v.media_id)) continue;
      out.push({
        igUserId: entry.id,
        mediaId: v.media_id,
        commentId: isId(v.comment_id) ? v.comment_id : null,
        sentAt,
      });
    }
  }
  return out;
}

/** The stable identity of one mention for one channel (caption mentions have no comment id). */
export function mentionDedupKey(mediaId: string, commentId: string | null | undefined): string {
  return commentId ? `${mediaId}:${commentId}` : `${mediaId}:caption`;
}

/** What we could learn about a mention from Graph. Every field may be missing. */
export interface InstagramMentionDetails {
  text: string | null;
  username: string | null;
  permalink: string | null;
  mediaType: string | null;
  timestamp: string | null;
}

const str = (v: unknown, max = 4000): string | null =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;

/** Only an instagram.com https link is ever stored as the permalink. */
export function safeInstagramPermalink(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && /(^|\.)instagram\.com$/i.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** GET /{ig-user-id}?fields=mentioned_comment.comment_id(X){…} */
export function parseMentionedComment(body: any): InstagramMentionDetails {
  const c = body?.mentioned_comment ?? {};
  const m = c.media ?? {};
  return {
    text: str(c.text),
    username: str(m.username, 100),
    permalink: safeInstagramPermalink(m.permalink),
    mediaType: str(m.media_type, 40),
    timestamp: str(c.timestamp, 40),
  };
}

/** GET /{ig-user-id}?fields=mentioned_media.media_id(X){…} */
export function parseMentionedMedia(body: any): InstagramMentionDetails {
  const m = body?.mentioned_media ?? {};
  return {
    text: str(m.caption),
    username: str(m.username, 100),
    permalink: safeInstagramPermalink(m.permalink),
    mediaType: str(m.media_type, 40),
    timestamp: str(m.timestamp, 40),
  };
}

export const IG_MENTIONED_COMMENT_FIELDS = "id,text,timestamp,media{id,permalink,username,media_type}";
export const IG_MENTIONED_COMMENT_FIELDS_MINIMAL = "id,text,timestamp";
export const IG_MENTIONED_MEDIA_FIELDS = "id,caption,media_type,permalink,username,timestamp";
export const IG_MENTIONED_MEDIA_FIELDS_MINIMAL = "id,caption,timestamp";

/** The automatic first comment, as stored on Post.metadata.instagramFirstComment. */
export interface InstagramFirstComment {
  text: string;
}

/** Read a stored first comment; anything malformed reads as none. */
export function readInstagramFirstComment(metadata: unknown): InstagramFirstComment | null {
  const raw = (metadata as any)?.instagramFirstComment;
  const text = typeof raw?.text === "string" ? raw.text.trim() : "";
  if (!text || text.length > IG_COMMENT_MAX_LENGTH) return null;
  return { text };
}

/** Per-target outcome of the first comment (PostTarget.metadata.firstComment). */
export type FirstCommentStatus = "posted" | "failed" | "unconfirmed" | "skipped";
export interface FirstCommentRecord {
  status: FirstCommentStatus;
  commentId?: string;
  error?: string;
  at: string;
}

export function readFirstCommentRecord(metadata: unknown): FirstCommentRecord | null {
  const raw = (metadata as any)?.firstComment;
  if (!raw || typeof raw !== "object") return null;
  if (!["posted", "failed", "unconfirmed", "skipped"].includes(raw.status)) return null;
  return {
    status: raw.status,
    commentId: typeof raw.commentId === "string" ? raw.commentId : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
    at: typeof raw.at === "string" ? raw.at : "",
  };
}
