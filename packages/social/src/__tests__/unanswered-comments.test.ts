import { describe, it, expect } from "vitest";
import { selectUnanswered } from "../utils/unanswered-comments";
import type { SocialComment } from "../utils/social-comments";

function c(id: string, over: Partial<SocialComment> = {}): SocialComment {
  return {
    id,
    text: `comment ${id}`,
    createdAt: "2026-10-05T10:00:00+0000",
    author: { id: "u", name: "Someone", username: null },
    likeCount: 0,
    hidden: false,
    replyCount: 0,
    replies: [],
    isOwn: false,
    canReply: true,
    attachmentType: null,
    likedByAccount: null,
    canHide: true,
    canDelete: true,
    canLike: true,
    canEdit: false,
    ...over,
  };
}

describe("selectUnanswered", () => {
  it("keeps a comment nobody replied to", () => {
    expect(selectUnanswered([c("1")]).map((u) => u.comment.id)).toEqual(["1"]);
  });

  it("drops comments the Page/account wrote itself and hidden comments", () => {
    expect(selectUnanswered([c("own", { isOwn: true }), c("hidden", { hidden: true })])).toEqual([]);
  });

  it("drops a comment with ANY embedded reply from the account, keeps one answered only by others", () => {
    const answered = c("a", { replyCount: 2, replies: [c("r1"), c("r2", { isOwn: true })] });
    const othersOnly = c("b", { replyCount: 1, replies: [c("r3")] });
    const out = selectUnanswered([answered, othersOnly]);
    expect(out.map((u) => u.comment.id)).toEqual(["b"]);
    expect(out[0]!.repliesPartial).toBe(false);
  });

  it("flags repliesPartial when more replies exist than were embedded (an older reply of ours may be among them)", () => {
    const out = selectUnanswered([c("p", { replyCount: 30, replies: [c("r1")] })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.repliesPartial).toBe(true);
  });

  it("keeps the input order", () => {
    expect(selectUnanswered([c("x"), c("y"), c("z")]).map((u) => u.comment.id)).toEqual(["x", "y", "z"]);
  });
});
