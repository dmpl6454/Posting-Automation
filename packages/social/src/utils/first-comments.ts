/**
 * Automatic first comments on our own Instagram and Facebook posts.
 *
 * 2026-10-17: one comment, Instagram only, posted right after publish
 * (`Post.metadata.instagramFirstComment = { text }`).
 * 2026-11-03: up to FIRST_COMMENTS_MAX comments, Instagram AND Facebook Pages,
 * optionally delayed (`Post.metadata.firstComments = { comments, delayMinutes }`).
 * The legacy marker is still read, so a post scheduled before the change keeps
 * its Instagram-only, immediate comment.
 *
 * Pure helpers only — the worker posts, the router validates.
 */

/** Instagram's comment ceiling — the lower of the two platforms (Facebook allows 8,000). */
export const FIRST_COMMENT_TEXT_MAX = 2200;
export const FIRST_COMMENTS_MAX = 5;
/** Longest allowed delay after publishing: one day. */
export const FIRST_COMMENT_DELAY_MAX_MINUTES = 1440;
export const FIRST_COMMENT_PLATFORMS: readonly string[] = ["INSTAGRAM", "FACEBOOK"];

export interface FirstCommentsPlan {
  comments: string[];
  delayMinutes: number;
  /** Platforms the plan applies to (the legacy marker is Instagram only). */
  platforms: readonly string[];
}

function cleanComments(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const c of raw) {
    const text = typeof c === "string" ? c.trim() : "";
    // Malformed entries make the whole plan unreadable rather than silently
    // posting a different set of comments than the one the user wrote.
    if (!text || text.length > FIRST_COMMENT_TEXT_MAX) return null;
    out.push(text);
  }
  if (out.length === 0 || out.length > FIRST_COMMENTS_MAX) return null;
  return out;
}

/** Read the stored plan; anything malformed reads as none. */
export function readFirstCommentsPlan(metadata: unknown): FirstCommentsPlan | null {
  const raw = (metadata as any)?.firstComments;
  if (raw && typeof raw === "object") {
    const comments = cleanComments(raw.comments);
    if (!comments) return null;
    const d = raw.delayMinutes;
    const delayMinutes =
      d === undefined || d === null
        ? 0
        : Number.isInteger(d) && d >= 0 && d <= FIRST_COMMENT_DELAY_MAX_MINUTES
          ? (d as number)
          : null;
    if (delayMinutes === null) return null;
    return { comments, delayMinutes, platforms: FIRST_COMMENT_PLATFORMS };
  }
  const legacy = (metadata as any)?.instagramFirstComment;
  const text = typeof legacy?.text === "string" ? legacy.text.trim() : "";
  if (!text || text.length > FIRST_COMMENT_TEXT_MAX) return null;
  return { comments: [text], delayMinutes: 0, platforms: ["INSTAGRAM"] };
}

/**
 * Per-target outcome (PostTarget.metadata.firstComment).
 * - `scheduled`: waiting for its delay; `dueAt` says when.
 * - `posting`: claimed by a worker. A record stuck here means the worker died
 *   mid-run — the outcome is unknown and is never retried automatically.
 * - `posted` / `failed` / `unconfirmed`: final. With several comments,
 *   `posted`/`total`/`items` say which ones made it.
 */
export type FirstCommentStatus = "scheduled" | "posting" | "posted" | "failed" | "unconfirmed" | "skipped";
export type FirstCommentItemStatus = "posted" | "failed" | "unconfirmed" | "skipped";

export interface FirstCommentItemRecord {
  status: FirstCommentItemStatus;
  commentId?: string;
  error?: string;
}

export interface FirstCommentRecord {
  status: FirstCommentStatus;
  commentId?: string;
  error?: string;
  at: string;
  dueAt?: string;
  posted?: number;
  total?: number;
  items?: FirstCommentItemRecord[];
}

const STATUSES: readonly string[] = ["scheduled", "posting", "posted", "failed", "unconfirmed", "skipped"];
const ITEM_STATUSES: readonly string[] = ["posted", "failed", "unconfirmed", "skipped"];

export function readFirstCommentRecord(metadata: unknown): FirstCommentRecord | null {
  const raw = (metadata as any)?.firstComment;
  if (!raw || typeof raw !== "object") return null;
  if (!STATUSES.includes(raw.status)) return null;
  const rec: FirstCommentRecord = {
    status: raw.status,
    commentId: typeof raw.commentId === "string" ? raw.commentId : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
    at: typeof raw.at === "string" ? raw.at : "",
  };
  if (typeof raw.dueAt === "string") rec.dueAt = raw.dueAt;
  if (Number.isInteger(raw.posted)) rec.posted = raw.posted;
  if (Number.isInteger(raw.total)) rec.total = raw.total;
  if (Array.isArray(raw.items)) {
    rec.items = raw.items
      .filter((i: any) => i && ITEM_STATUSES.includes(i.status))
      .map((i: any) => ({
        status: i.status,
        ...(typeof i.commentId === "string" ? { commentId: i.commentId } : {}),
        ...(typeof i.error === "string" ? { error: i.error } : {}),
      }));
  }
  return rec;
}

/**
 * Fold per-comment outcomes into the final record. A single comment keeps the
 * exact 2026-10-17 shape (no counts, no items).
 *
 * Overall status: every comment posted ⇒ posted; any unknown outcome ⇒
 * unconfirmed (it may be live — nobody should re-add it blindly); otherwise
 * failed, with the first error.
 */
export function summarizeFirstComments(items: FirstCommentItemRecord[], at: string): FirstCommentRecord {
  const posted = items.filter((i) => i.status === "posted").length;
  const status: FirstCommentStatus =
    posted === items.length && items.length > 0
      ? "posted"
      : items.some((i) => i.status === "unconfirmed")
        ? "unconfirmed"
        : "failed";
  const firstError = items.find((i) => i.error)?.error;
  const firstId = items.find((i) => i.commentId)?.commentId;
  if (items.length === 1) {
    const only = items[0]!;
    return {
      status,
      ...(only.commentId ? { commentId: only.commentId } : {}),
      ...(only.error ? { error: only.error } : {}),
      at,
    };
  }
  return {
    status,
    ...(firstId ? { commentId: firstId } : {}),
    ...(firstError && status !== "posted" ? { error: firstError } : {}),
    at,
    posted,
    total: items.length,
    items,
  };
}

/** The delayed-comment job id — exactly three colon segments (BullMQ's rule). */
export function firstCommentJobId(postTargetId: string): string {
  return `fcomment:${postTargetId}:v1`;
}
