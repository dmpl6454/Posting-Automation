import type { CommentModerationAction, SocialComment } from "@postautomation/social";

/**
 * Apply a CONFIRMED moderation result to one comment (top-level or reply) in
 * the loaded Comments pages — so the thread updates without re-reading every
 * page from Meta (each re-read spends the Page's rate budget, shared with
 * publishing). Returns null when the comment was deleted.
 *
 * Likes, two cases:
 *   - Facebook reports whether the Page liked the comment (`likedByAccount` is a
 *     boolean), so the count moves by exactly ±1 — or 0 when the state already
 *     matched.
 *   - Instagram exposes NO "liked by me" field (`likedByAccount` is null) and
 *     its like/unlike "has no effect" when the state already matches, so a
 *     success cannot say whether the count moved. The server re-reads the real
 *     `like_count` and passes it as `likeCount`; when that re-read failed it
 *     sends `null` and the count is left alone rather than guessed.
 *
 * `likeCount === undefined` (Facebook never sends one) keeps the original
 * Facebook arithmetic byte-for-byte — locked by comment-moderation-patch.test.ts.
 */
export function applyModeration(
  c: SocialComment,
  id: string,
  action: CommentModerationAction,
  message?: string,
  likeCount?: number | null
): SocialComment | null {
  if (c.id === id) {
    if (action === "delete") return null;
    if (action === "hide" || action === "unhide") return { ...c, hidden: action === "hide" };
    if (action === "like" || action === "unlike") {
      const liked = action === "like";
      if (likeCount !== undefined) {
        // The server re-read the count (Instagram): trust a real number; a null or
        // nonsensical one means "could not read" — keep the count, don't guess.
        return typeof likeCount === "number" && Number.isFinite(likeCount) && likeCount >= 0
          ? { ...c, likedByAccount: liked, likeCount: Math.floor(likeCount) }
          : { ...c, likedByAccount: liked };
      }
      const delta = liked === !!c.likedByAccount ? 0 : liked ? 1 : -1;
      return { ...c, likedByAccount: liked, likeCount: Math.max(0, c.likeCount + delta) };
    }
    return { ...c, text: message ?? c.text };
  }
  if (!c.replies.some((r) => r.id === id)) return c;
  const replies = c.replies
    .map((r) => applyModeration(r, id, action, message, likeCount))
    .filter((r): r is SocialComment => r !== null);
  const removed = c.replies.length - replies.length;
  return { ...c, replies, replyCount: Math.max(0, c.replyCount - removed) };
}
