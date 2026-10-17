import { describe, it, expect, vi } from "vitest";
import { postFirstComment, type FirstCommentArgs } from "./first-comment";

const base: FirstCommentArgs = {
  platform: "INSTAGRAM",
  isStoryTarget: false,
  postMetadata: { instagramFirstComment: { text: "#love #travel" } },
  targetId: "t1",
  targetMetadata: {},
  mediaId: "17890000000000001",
  tokens: { accessToken: "TOKEN" },
};

function deps(commentOnMedia: (...a: any[]) => Promise<{ id: string }>) {
  const writes: string[] = [];
  return {
    writes,
    d: {
      prisma: {
        $executeRaw: vi.fn(async (_strings: TemplateStringsArray, patch: string) => {
          writes.push(patch);
          return 1;
        }),
      },
      commentOnMedia: vi.fn(commentOnMedia),
      now: () => new Date("2026-10-17T10:00:00Z"),
    },
  };
}

describe("postFirstComment", () => {
  it("posts the comment on the published media and records it", async () => {
    const { d, writes } = deps(async () => ({ id: "c9" }));
    const r = await postFirstComment(d, base);
    expect(d.commentOnMedia).toHaveBeenCalledWith({ accessToken: "TOKEN" }, "17890000000000001", "#love #travel");
    expect(r).toEqual({ status: "posted", commentId: "c9", at: "2026-10-17T10:00:00.000Z" });
    expect(JSON.parse(writes[0]!)).toEqual({ firstComment: r });
  });

  it.each([
    ["not Instagram", { platform: "FACEBOOK" }],
    ["a story", { isStoryTarget: true }],
    ["no media id", { mediaId: null }],
    ["no first comment configured", { postMetadata: {} }],
    ["an outcome already recorded", { targetMetadata: { firstComment: { status: "unconfirmed", at: "x" } } }],
  ])("does nothing for %s", async (_l, over) => {
    const { d, writes } = deps(async () => ({ id: "c" }));
    expect(await postFirstComment(d, { ...base, ...(over as any) })).toBeNull();
    expect(d.commentOnMedia).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it("an unknown outcome is recorded as unconfirmed, never retried, never thrown", async () => {
    const { d } = deps(async () => {
      throw new Error("Instagram accepted the comment but did not confirm it. … it may already be posted.");
    });
    const r = await postFirstComment(d, base);
    expect(r?.status).toBe("unconfirmed");
  });

  it("a refusal is recorded as failed with the message", async () => {
    const { d } = deps(async () => {
      throw new Error("Instagram hasn't granted comment permission");
    });
    const r = await postFirstComment(d, base);
    expect(r).toMatchObject({ status: "failed", error: "Instagram hasn't granted comment permission" });
  });

  it("never throws, even when recording fails", async () => {
    const { d } = deps(async () => ({ id: "c" }));
    d.prisma.$executeRaw = vi.fn(async () => {
      throw new Error("db down");
    }) as any;
    await expect(postFirstComment(d, base)).resolves.toMatchObject({ status: "posted" });
  });
});
