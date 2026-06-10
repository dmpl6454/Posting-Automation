import { describe, it, expect } from "vitest";
import { buildPublishNotifications } from "./publish-recovery";

describe("buildPublishNotifications", () => {
  const opts = {
    organizationId: "org-1",
    postId: "post-1",
    postTargetId: "pt-1",
    platform: "TWITTER",
  };

  it("returns one PUBLISHED notification per member with correct shape", () => {
    const rows = buildPublishNotifications(["user-a", "user-b"], {
      ...opts,
      status: "PUBLISHED",
    });
    expect(rows).toHaveLength(2);
    for (const [i, userId] of ["user-a", "user-b"].entries()) {
      expect(rows[i]!.userId).toBe(userId);
      expect(rows[i]!.organizationId).toBe("org-1");
      expect(rows[i]!.type).toBe("post.published");
      expect(rows[i]!.link).toBe("/dashboard/posts/post-1");
      expect(rows[i]!.title).toBeTruthy();
      expect(rows[i]!.body).toContain("TWITTER");
      expect(rows[i]!.metadata).toEqual({
        postId: "post-1",
        postTargetId: "pt-1",
        platform: "TWITTER",
      });
    }
  });

  it("uses post.failed type when status is FAILED", () => {
    const rows = buildPublishNotifications(["user-a"], {
      ...opts,
      status: "FAILED",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("post.failed");
    expect(rows[0]!.link).toBe("/dashboard/posts/post-1");
    expect(rows[0]!.metadata).toEqual({
      postId: "post-1",
      postTargetId: "pt-1",
      platform: "TWITTER",
    });
  });

  it("returns an empty array when there are no members", () => {
    const rows = buildPublishNotifications([], { ...opts, status: "PUBLISHED" });
    expect(rows).toEqual([]);
  });
});
