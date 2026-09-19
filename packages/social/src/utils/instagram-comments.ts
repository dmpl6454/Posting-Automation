/**
 * Instagram comment reply feature (2026-09-19).
 *
 * Pure parsing/classification logic, extracted from instagram.provider.ts so
 * it is testable without mocking fetch — same discipline as instagram-story.ts
 * and fb-video-post-id.ts.
 *
 * Requires `instagram_manage_comments` — requested in getDefaultScopes
 * (channel.router.ts) but NOT YET Advanced-Access approved for external
 * users (Meta rejected the original request in 2026-06 for having no real
 * feature behind it; this IS that feature). App-role accounts (admin/dev/
 * tester) get the scope immediately on reconnect and can use this today,
 * which also satisfies Meta's "one successful call exercising the
 * permission" App Review test-call gate for a future resubmission.
 */

export interface InstagramComment {
  id: string;
  text: string;
  timestamp: string;
  username: string | null;
  likeCount: number;
  hidden: boolean;
}

export interface InstagramCommentPage {
  comments: InstagramComment[];
  nextCursor: string | null;
}

export interface MetaErrorLike {
  code?: number | string;
  message?: string;
  error_subcode?: number | string;
}

/** `#100` is overloaded (also a generic validation error) — subcode 33 is
 * specifically "does not exist / has been deleted", per the same pair this
 * codebase already relies on for object-not-found elsewhere. */
const OBJECT_GONE_SUBCODE = 33;

/** Graph API shape for GET /{ig-media-id}/comments. */
export function parseCommentsPage(data: {
  data?: Array<{
    id: string;
    text?: string;
    timestamp?: string;
    username?: string;
    like_count?: number;
    hidden?: boolean;
  }>;
  paging?: { next?: string; cursors?: { after?: string } };
}): InstagramCommentPage {
  const comments = (data.data ?? []).map((c) => ({
    id: c.id,
    text: c.text ?? "",
    timestamp: c.timestamp ?? "",
    username: c.username ?? null,
    likeCount: c.like_count ?? 0,
    hidden: c.hidden ?? false,
  }));
  // Only surface a cursor when Meta's own `paging.next` says a page actually
  // follows — `cursors.after` can be present even on the last page for some
  // Graph edges, and a stray cursor would let the UI request a page that
  // returns empty forever.
  const nextCursor = data.paging?.next ? (data.paging.cursors?.after ?? null) : null;
  return { comments, nextCursor };
}

/**
 * Meta's IG Comment permission-denied shape — `(#10) Application does not
 * have permission for this action`, code 10, type OAuthException. Kept
 * narrow and message-pattern-based (mirrors the worker's `classifyError`
 * style) rather than a broad code range, since code 10 is also used for a
 * handful of unrelated Graph restrictions and the WORDING is what actually
 * distinguishes "we don't have the scope" from those.
 */
export function isCommentPermissionDeniedError(err: MetaErrorLike | undefined | null): boolean {
  if (!err) return false;
  const code = Number(err.code);
  const message = String(err.message ?? "");
  return code === 10 && /does not have permission/i.test(message);
}

export const COMMENT_PERMISSION_DENIED_MESSAGE =
  "This Instagram account hasn't been granted comment-reply permission yet. " +
  "Try disconnecting and reconnecting the channel — if it still doesn't work, " +
  "Meta hasn't approved this feature for accounts outside our own team yet.";

/**
 * `#100 / subcode 33` "Object does not exist" — the comment (or the reply
 * target's parent media) was deleted between list and reply. NOT a token
 * error (see the #100/33 note in CLAUDE.md's degraded-capture section) —
 * distinct message so a stale comment doesn't read as a permission problem.
 */
export function isCommentObjectGoneError(err: MetaErrorLike | undefined | null): boolean {
  if (!err) return false;
  return Number(err.code) === 100 && Number(err.error_subcode) === OBJECT_GONE_SUBCODE;
}

export const COMMENT_OBJECT_GONE_MESSAGE =
  "That comment no longer exists — it may have been deleted. Refresh and try again.";

/** Instagram comment text limit (same as a normal IG comment). */
export const COMMENT_REPLY_MAX_LENGTH = 2200;
