/**
 * Facebook Page comment read + reply (2026-09-23).
 *
 * Pure parsing/classification, extracted from facebook.provider.ts so it is
 * testable without mocking fetch — same discipline as instagram-comments.ts.
 *
 * ── Permissions (see docs/META-COMMENTS-APP-REVIEW-RUNBOOK-2026-09-23.md) ────
 *   READ  GET  /{page-post-id}/comments  → Page token + pages_read_engagement
 *                                          + pages_read_user_content, and the
 *                                          connecting person must be able to
 *                                          perform the MODERATE task on the Page.
 *   REPLY POST /{comment-id}/comments    → Page token + pages_manage_engagement.
 *
 * `pages_read_user_content` is APPROVED on the legacy app (Post Automation 2,
 * 298449321694397) and REJECTED once on app B (259982148841906, awaiting
 * resubmission). `pages_manage_engagement` is requested on BOTH apps from
 * 2026-09-23 and approved on NEITHER yet. Until approval only app-role
 * accounts (admin/dev/tester) receive them — which is also exactly what Meta's
 * "one successful API call per permission" App Review gate needs.
 */

import {
  nextCursorFromPaging,
  safeCount,
  type SocialComment,
  type SocialCommentPage,
} from "./social-comments";

/** Replies embedded per top-level comment (field expansion, one round-trip). */
export const FB_EMBEDDED_REPLY_LIMIT = 25;

/** Top-level comments per page. */
export const FB_COMMENT_PAGE_SIZE = 25;

const FB_REPLY_FIELDS =
  "id,message,created_time,from{id,name},like_count,is_hidden,attachment{type},user_likes,can_hide,can_remove,can_like";

/**
 * The NEWEST replies, not the oldest: on a busy comment (more than the limit)
 * the Page's just-sent reply must be in the embedded page, or "refresh before
 * replying again" could never find it. Graph validates the `order` value
 * (live-verified 2026-09-23: a bogus value 400s with "order must be one of
 * chronological, reverse_chronological"). The parser flips them back to
 * oldest-first for reading.
 */
const FB_EMBEDDED_REPLIES = `comments.order(reverse_chronological).limit(${FB_EMBEDDED_REPLY_LIMIT})`;

/**
 * Fields for GET /{object-id}/comments. Every name here is a documented
 * Comment field; ONE unknown name 400s the whole call, so do not add a field
 * without checking the Comment reference first.
 */
export const FB_COMMENT_FIELDS =
  "id,message,created_time,from{id,name},like_count,comment_count,is_hidden,can_comment,attachment{type}," +
  "user_likes,can_hide,can_remove,can_like," +
  `${FB_EMBEDDED_REPLIES}{${FB_REPLY_FIELDS}}`;

/**
 * Fallback rung used ONLY when Meta rejects a name in FB_COMMENT_FIELDS
 * (isGraphFieldError). Every field here appears either in the v26 Comment
 * reference as rendered (like_count, comment_count, can_comment) or in Meta's
 * own Pages "Comments" guide example (message, from), so it degrades the thread
 * (no hidden/attachment flags) instead of breaking it. `is_hidden` and
 * `attachment` are the two names in the preferred set the v26 page does not
 * render, hence the only ones dropped.
 */
export const FB_COMMENT_FIELDS_MINIMAL =
  "id,message,created_time,from{id,name},like_count,comment_count,can_comment,user_likes," +
  `${FB_EMBEDDED_REPLIES}{id,message,created_time,from{id,name},like_count,user_likes}`;

/** Facebook's comment length ceiling. */
export const FB_COMMENT_MAX_LENGTH = 8000;

interface FbCommentRow {
  id: string;
  message?: string;
  created_time?: string;
  from?: { id?: string; name?: string };
  like_count?: number;
  comment_count?: number;
  is_hidden?: boolean;
  can_comment?: boolean;
  attachment?: { type?: string };
  user_likes?: boolean;
  can_hide?: boolean;
  can_remove?: boolean;
  can_like?: boolean;
  comments?: { data?: FbCommentRow[] };
}

function toSocialComment(row: FbCommentRow, pageId: string | null, isReply: boolean): SocialComment {
  // Fetched newest-first (FB_EMBEDDED_REPLIES) so the latest reply is always
  // included; shown oldest-first, the order a conversation is read in.
  const replies = isReply
    ? []
    : (row.comments?.data ?? []).map((r) => toSocialComment(r, pageId, true)).reverse();
  const authorId = row.from?.id ?? null;
  return {
    id: row.id,
    text: row.message ?? "",
    createdAt: row.created_time ?? "",
    author: { id: authorId, name: row.from?.name ?? null, username: null },
    likeCount: safeCount(row.like_count),
    hidden: row.is_hidden === true,
    // comment_count is the TRUE reply total; embedded replies are only the
    // first FB_EMBEDDED_REPLY_LIMIT. Never report fewer than we can see.
    replyCount: isReply ? 0 : Math.max(safeCount(row.comment_count), replies.length),
    replies,
    isOwn: !!pageId && authorId === pageId,
    // A reply is never replyable here (see SocialComment.canReply). For a
    // top-level comment, trust Meta's can_comment when it is present — it is
    // false on e.g. a post whose comments were turned off after the fact.
    canReply: isReply ? false : row.can_comment !== false,
    attachmentType: row.attachment?.type ?? null,
    likedByAccount: typeof row.user_likes === "boolean" ? row.user_likes : null,
    // Trust Meta's can_* when present (they are absent on the minimal rung).
    // A Page cannot hide its OWN comment; it can delete it and edit it.
    canHide: row.can_hide ?? authorId !== pageId,
    canDelete: row.can_remove ?? true,
    canLike: row.can_like ?? true,
    canEdit: !!pageId && authorId === pageId,
  };
}

/**
 * Graph shape for GET /{object-id}/comments?filter=toplevel&summary=true.
 *
 * @param pageId The connected Page's id — used ONLY to flag the Page's own
 *               replies (`isOwn`). Null disables the flag, never the parse.
 */
export function parseFacebookCommentsPage(
  data: {
    data?: FbCommentRow[];
    paging?: { next?: string; cursors?: { after?: string } };
    summary?: { total_count?: number };
  },
  pageId: string | null
): SocialCommentPage {
  const total = data.summary?.total_count;
  return {
    comments: (data.data ?? []).map((row) => toSocialComment(row, pageId, false)),
    nextCursor: nextCursorFromPaging(data.paging),
    totalCount: typeof total === "number" && Number.isFinite(total) ? total : null,
  };
}

export interface FbErrorLike {
  code?: number | string;
  error_subcode?: number | string;
  message?: string;
}

/**
 * Missing permission for a comment call. Graph uses `#10` ("Application does
 * not have permission…" / "requires … pages_read_user_content") and the
 * `#200`–`#299` permission family ("(#200) … pages_manage_engagement"). Unlike
 * the Instagram classifier, Facebook's permission errors name the scope in the
 * message rather than using one stable sentence, so the CODE family is the
 * signal here — narrowed to exclude `#10`'s unrelated overloads by requiring a
 * permission-ish word.
 */
export function isFbCommentPermissionError(err: FbErrorLike | undefined | null): boolean {
  if (!err) return false;
  const code = Number(err.code);
  const message = String(err.message ?? "");
  if (code >= 200 && code <= 299) return true;
  // `(#100) Missing Permission` — observed LIVE 2026-09-23 on a reply from a
  // token minted before the comment scope was requested. #100 is overloaded,
  // so the wording is what identifies it.
  // ⚠️ NOT a loose /missing permission/ match: Meta's standard #100/subcode-33
  // "object does not exist" text reads "…cannot be loaded due to missing
  // permissions, or…", which would mislabel every deleted post/comment.
  if (code === 100 && Number(err.error_subcode) !== 33 && /^\(#100\) missing permission\b/i.test(message)) return true;
  return code === 10 && /permission|pages_read_user_content|pages_manage_engagement|pages_read_engagement/i.test(message);
}

/** `#190` — the stored Page token is dead or the person lost the Page role. */
export function isFbTokenInvalidError(err: FbErrorLike | undefined | null): boolean {
  if (!err) return false;
  return Number(err.code) === 190;
}

/**
 * Throttling / abuse limits. `368` is "temporarily blocked for policies
 * violations" — typically too many identical replies in a short time — and must
 * read as "slow down", not as a generic failure the user will retry at once.
 */
export function isFbCommentThrottleError(err: FbErrorLike | undefined | null): boolean {
  if (!err) return false;
  const code = Number(err.code);
  return code === 4 || code === 17 || code === 32 || code === 368 || code === 613 || (code >= 80000 && code <= 80099);
}

export const FB_COMMENT_PERMISSION_DENIED_MESSAGE =
  "This Facebook Page hasn't granted comment access yet. Reconnect the channel on the Channels page " +
  "(choose “Edit settings” and keep this Page ticked). If it still doesn't work, Meta hasn't approved " +
  "comment access for accounts outside our own team yet.";

export const FB_COMMENT_ACTION_FAILED_MESSAGE =
  "Facebook couldn't complete that action right now. Refresh the comments and try again.";

export const FB_COMMENT_TOKEN_INVALID_MESSAGE =
  "Facebook rejected this Page's connection. Reconnect the channel on the Channels page, then try again.";

export const FB_COMMENT_THROTTLED_MESSAGE =
  "Facebook is temporarily limiting activity for this Page. Please wait a few minutes before trying again.";

/** `#100/33` on the LIST call — the post itself is gone, not a comment. */
export const FB_COMMENT_POST_GONE_MESSAGE =
  "This post is no longer available on Facebook — it may have been deleted there.";

export const FB_COMMENT_LIST_FAILED_MESSAGE =
  "Facebook couldn't load the comments right now. Please try again in a moment.";

export const FB_COMMENT_REPLY_FAILED_MESSAGE =
  "Facebook couldn't post that reply right now. Please try again in a moment.";

export const FB_COMMENT_REPLY_UNCONFIRMED_MESSAGE =
  "Facebook accepted the reply but did not confirm it. Refresh the comments before replying again — it may already be posted.";
