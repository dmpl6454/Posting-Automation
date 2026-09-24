import { describe, it, expect } from "vitest";
import type { SocialComment } from "@postautomation/social";
import { applyModeration } from "./comment-moderation-patch";

function comment(over: Partial<SocialComment> = {}): SocialComment {
  return {
    id: "c1",
    text: "nice",
    createdAt: "",
    author: { id: null, name: null, username: "fan" },
    likeCount: 5,
    hidden: false,
    replyCount: 0,
    replies: [],
    isOwn: false,
    canReply: true,
    attachmentType: null,
    likedByAccount: false,
    canHide: true,
    canDelete: true,
    canLike: true,
    canEdit: false,
    ...over,
  };
}

describe("applyModeration — Facebook arithmetic is unchanged (no likeCount from the server)", () => {
  it("like / unlike move the count by exactly one, or not at all when the state already matched", () => {
    expect(applyModeration(comment({ likedByAccount: false }), "c1", "like")).toMatchObject({ likedByAccount: true, likeCount: 6 });
    expect(applyModeration(comment({ likedByAccount: true }), "c1", "like")).toMatchObject({ likedByAccount: true, likeCount: 5 });
    expect(applyModeration(comment({ likedByAccount: true }), "c1", "unlike")).toMatchObject({ likedByAccount: false, likeCount: 4 });
    expect(applyModeration(comment({ likedByAccount: false, likeCount: 0 }), "c1", "unlike")).toMatchObject({ likeCount: 0 });
  });

  it("a null state with NO likeCount keeps the original behaviour (null read as not-liked)", () => {
    expect(applyModeration(comment({ likedByAccount: null }), "c1", "like")).toMatchObject({ likedByAccount: true, likeCount: 6 });
  });

  it("hide / delete / edit and replies behave exactly as before", () => {
    expect(applyModeration(comment(), "c1", "hide")).toMatchObject({ hidden: true });
    expect(applyModeration(comment(), "c1", "delete")).toBeNull();
    expect(applyModeration(comment(), "c1", "edit", "fixed")).toMatchObject({ text: "fixed" });
    const parent = comment({ id: "p", replyCount: 2, replies: [comment({ id: "r1" }), comment({ id: "r2" })] });
    const after = applyModeration(parent, "r1", "delete")!;
    expect(after.replies.map((r) => r.id)).toEqual(["r2"]);
    expect(after.replyCount).toBe(1);
    expect(applyModeration(comment({ id: "other" }), "c1", "hide")).toMatchObject({ id: "other", hidden: false });
  });
});

describe("applyModeration — Instagram (like state is unknowable, count is re-read)", () => {
  it("uses the server's re-read count instead of guessing ±1", () => {
    // Already liked on the phone: Meta's like 'has no effect', count stays 5.
    expect(applyModeration(comment({ likedByAccount: null }), "c1", "like", undefined, 5)).toMatchObject({ likedByAccount: true, likeCount: 5 });
    expect(applyModeration(comment({ likedByAccount: null }), "c1", "unlike", undefined, 4)).toMatchObject({ likedByAccount: false, likeCount: 4 });
  });

  it("a failed re-read (null) leaves the count alone rather than guessing", () => {
    expect(applyModeration(comment({ likedByAccount: null, likeCount: 5 }), "c1", "like", undefined, null)).toMatchObject({
      likedByAccount: true,
      likeCount: 5,
    });
  });

  it("applies to a reply inside a thread too", () => {
    const parent = comment({ id: "p", replies: [comment({ id: "r1", likedByAccount: null, likeCount: 0 })] });
    const after = applyModeration(parent, "r1", "like", undefined, 1)!;
    expect(after.replies[0]).toMatchObject({ likedByAccount: true, likeCount: 1 });
  });

  it("ignores a nonsensical count", () => {
    expect(applyModeration(comment({ likedByAccount: null, likeCount: 3 }), "c1", "like", undefined, -1)).toMatchObject({ likeCount: 3 });
  });
});
