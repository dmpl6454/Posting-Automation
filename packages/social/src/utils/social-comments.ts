/**
 * Platform-neutral comment shape (2026-09-23).
 *
 * Facebook Page comments and Instagram media comments are read through two
 * different Graph edges with different field names (`message`/`created_time`/
 * `from{id,name}` vs `text`/`timestamp`/`username`). Both providers' readers
 * normalise into THIS shape, so the web UI renders one thread component for
 * both platforms and `comment.router` never branches on response shape.
 *
 * Pure types + tiny helpers only — the per-platform parsers live beside their
 * Graph specifics in facebook-comments.ts / instagram-comments.ts.
 */

import { isIndeterminatePublishError } from "./ambiguous-publish";

export type CommentPlatform = "FACEBOOK" | "INSTAGRAM";

export interface SocialCommentAuthor {
  /** Platform-scoped id of the commenter, when Meta returns one. */
  id: string | null;
  /** Display name (Facebook). null when Meta withholds the commenter identity. */
  name: string | null;
  /** Handle without "@" (Instagram). Always null on Facebook. */
  username: string | null;
}

export interface SocialComment {
  id: string;
  /** Comment text. "" for an attachment-only comment (see attachmentType). */
  text: string;
  /** Timestamp exactly as Graph returns it ("2026-09-19T10:00:00+0000"); "" if absent. */
  createdAt: string;
  author: SocialCommentAuthor;
  likeCount: number;
  hidden: boolean;
  /**
   * Replies Meta reports for this comment. May exceed `replies.length` — only
   * the first page of replies is embedded. 0 on a reply itself.
   */
  replyCount: number;
  /** First page of replies, already nested under their top-level comment. */
  replies: SocialComment[];
  /**
   * Written by the connected Page / account itself — i.e. one of OUR replies.
   * The UI labels these so the operator can see their reply landed.
   */
  isOwn: boolean;
  /**
   * Whether the connected account can reply to this comment through the API.
   * Replies are always top-level-only here: Instagram's `/replies` edge only
   * accepts top-level comments, and on Facebook a reply to a reply lands in the
   * same thread anyway — replying to the parent keeps both platforms identical.
   */
  canReply: boolean;
  /** Facebook attachment type ("photo", "sticker", "animated_image_share"…), else null. */
  attachmentType: string | null;
  /**
   * Has the connected Page liked this comment (Facebook `user_likes`, the viewer
   * being the Page)? null where the platform can't tell us (Instagram — liking
   * needs `instagram_manage_engagement`, which this app does not request).
   */
  likedByAccount: boolean | null;
  /** Moderation affordances, as far as the platform reports them. */
  canHide: boolean;
  canDelete: boolean;
  /** Like as the Page — Facebook only. */
  canLike: boolean;
  /** Edit the text — only the Page's OWN Facebook comments. */
  canEdit: boolean;
}

export interface SocialCommentPage {
  comments: SocialComment[];
  /** Cursor for the next page — non-null ONLY when Meta's `paging.next` exists. */
  nextCursor: string | null;
  /**
   * Meta's own total of top-level comments when it reports one (Facebook
   * `summary=true`), else null. Can differ from what is listable — Meta
   * applies privacy filtering to the list, not always to the count.
   */
  totalCount: number | null;
}

/**
 * Only surface a cursor when Meta's own `paging.next` says a page actually
 * follows. `cursors.after` can be present on the LAST page for some Graph
 * edges, and a stray cursor lets the UI request a page that is empty forever.
 */
export function nextCursorFromPaging(
  paging: { next?: string; cursors?: { after?: string } } | undefined
): string | null {
  return paging?.next ? (paging.cursors?.after ?? null) : null;
}

/**
 * `(#100) Tried accessing nonexisting field (x) on node type (Comment)` — Meta
 * renamed or removed a field we request. One unknown name 400s the WHOLE call,
 * so the comment readers answer this by retrying once with a minimal field set
 * rather than breaking the thread outright.
 *
 * ⚠️ Graph does NOT validate field names on an EMPTY edge (verified live
 * 2026-09-23: a bogus field on a post with zero comments returns HTTP 200) —
 * which is why a renamed field can ship unnoticed and surface only on the
 * first post that has comments. `#100` alone is overloaded (object-not-found,
 * validation), so the message is what identifies a FIELD error.
 */
export function isGraphFieldError(err: { code?: number | string; message?: string } | undefined | null): boolean {
  if (!err) return false;
  return Number(err.code) === 100 && /nonexisting field|tried accessing/i.test(String(err.message ?? ""));
}

/**
 * A 4xx reply error whose outcome is nonetheless UNKNOWN: Meta flags
 * `is_transient: true`, or code 2 (service fault — work may have begun). This
 * is the exact response shape of the 2026-08-18 duplicate-post incident, and
 * creating a reply is not idempotent, so it must read as "may already be
 * posted", never "failed". Delegates to the publish path's classifier so the
 * load-bearing order (throttle codes are definite refusals and win over
 * `is_transient`) lives in ONE place.
 */
export function isIndeterminateReplyError(body: { error?: unknown } | null | undefined): boolean {
  if (!body || typeof body !== "object" || !body.error || typeof body.error !== "object") return false;
  return isIndeterminatePublishError(new Error(`reply failed: ${JSON.stringify({ error: body.error })}`));
}

/**
 * What a channel's token may do with comments, from the scopes Meta GRANTED it
 * (debug_token). Requesting a scope is not being granted it: a token minted
 * before a scope was added — or by a person Meta won't grant it to yet — lacks
 * it until the channel is reconnected, and Meta then fails the call with
 * `(#100) Missing Permission` / `#10` / `#200`, or (Instagram) silently withholds
 * the commenter's `username`.
 *
 *   Facebook   read → pages_read_user_content · reply/like/hide/delete/edit → pages_manage_engagement
 *   Instagram  everything → instagram_manage_comments
 *
 * `known: false` when the grant has not been checked yet (then every flag is
 * null and the UI must not guess).
 */
export interface CommentCapabilities {
  known: boolean;
  canRead: boolean | null;
  canReply: boolean | null;
  canModerate: boolean | null;
  /** Instagram withholds commenter usernames without instagram_manage_comments. */
  namesHidden: boolean | null;
  /** Scopes the channel is missing for the full feature, in request order. */
  missing: string[];
}

export const COMMENT_READ_SCOPES: Record<CommentPlatform, string[]> = {
  FACEBOOK: ["pages_read_engagement", "pages_read_user_content"],
  INSTAGRAM: ["instagram_basic", "instagram_manage_comments"],
};

export const COMMENT_WRITE_SCOPES: Record<CommentPlatform, string[]> = {
  FACEBOOK: ["pages_manage_engagement"],
  INSTAGRAM: ["instagram_manage_comments"],
};

export function commentCapabilities(
  platform: CommentPlatform,
  grantedScopes: readonly string[] | null | undefined
): CommentCapabilities {
  if (!Array.isArray(grantedScopes)) {
    return { known: false, canRead: null, canReply: null, canModerate: null, namesHidden: null, missing: [] };
  }
  const has = (s: string) => grantedScopes.includes(s);
  const readOk = COMMENT_READ_SCOPES[platform].every(has);
  const writeOk = COMMENT_WRITE_SCOPES[platform].every(has);
  const missing = [...COMMENT_READ_SCOPES[platform], ...COMMENT_WRITE_SCOPES[platform]].filter(
    (s, i, all) => !has(s) && all.indexOf(s) === i
  );
  return {
    known: true,
    // Instagram comments still LIST without instagram_manage_comments — just
    // without usernames — so reading only needs instagram_basic there.
    canRead: platform === "INSTAGRAM" ? has("instagram_basic") : readOk,
    canReply: writeOk,
    canModerate: writeOk,
    namesHidden: platform === "INSTAGRAM" ? !has("instagram_manage_comments") : false,
    missing,
  };
}

/**
 * An idempotent moderation action (hide, delete, like, edit) whose outcome we
 * could not confirm. Unlike a reply, repeating it cannot duplicate anything —
 * but the user must still see the real state before deciding, hence "refresh".
 */
export const COMMENT_ACTION_UNCONFIRMED_MESSAGE =
  "The platform didn't confirm that change. Refresh the comments to see the current state.";

export type CommentModerationAction = "hide" | "unhide" | "delete" | "like" | "unlike" | "edit";

/** Non-negative integer or 0 — Graph omits counts it cannot report. */
export function safeCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
