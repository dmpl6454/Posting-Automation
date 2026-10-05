/**
 * Unanswered-comments queue (2026-10-05) — which comments still need a reply.
 *
 * Pure, so the rule is testable without Graph. It runs over the FIRST page of
 * top-level comments the providers already return (each with its first page of
 * replies embedded), so it costs nothing beyond the comment read itself.
 *
 * A comment is "unanswered" when ALL of these hold:
 *   - it was not written by the connected Page/account itself (`isOwn`);
 *   - it is not hidden (a hidden comment is already handled — and Instagram
 *     refuses replies to hidden comments anyway);
 *   - none of its embedded replies was written by the Page/account.
 *
 * ⚠️ Only the EMBEDDED replies can be checked. Facebook embeds the NEWEST 25
 * (`comments.order(reverse_chronological)`), Instagram its first page. When a
 * comment reports more replies than were embedded and none of the embedded ones
 * is ours, an older reply of ours may exist outside the window — the item is
 * still listed but flagged `repliesPartial`, so the UI can say "may already have
 * a reply" instead of asserting it has none.
 */

import type { SocialComment } from "./social-comments";

export interface UnansweredComment {
  comment: SocialComment;
  /** More replies exist than were checked — an older reply of ours may be among them. */
  repliesPartial: boolean;
}

export function selectUnanswered(comments: readonly SocialComment[]): UnansweredComment[] {
  const out: UnansweredComment[] = [];
  for (const c of comments) {
    if (c.isOwn || c.hidden) continue;
    if (c.replies.some((r) => r.isOwn)) continue;
    out.push({ comment: c, repliesPartial: c.replyCount > c.replies.length });
  }
  return out;
}
