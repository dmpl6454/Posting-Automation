/**
 * Per-PAGE comment budgets (2026-09-23). The same Facebook Page can be
 * connected in several workspaces, and Meta's rate quota is per Page — so a
 * per-user limit alone would let N users multiply the Page's budget (which the
 * publish worker also spends). Separate file so module-level limiter state is fresh.
 */
import { describe, it, expect, vi } from "vitest";

const replyToComment = vi.fn(async () => ({ id: "R" }));
const getPostComments = vi.fn(async () => ({ comments: [], nextCursor: null, totalCount: 0 }));

vi.mock("@postautomation/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@postautomation/social")>();
  return { ...actual, getSocialProvider: vi.fn(() => ({ replyToComment, getPostComments })) };
});
vi.mock("../lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/audit")>();
  return { ...actual, createAuditLog: vi.fn(async () => {}) };
});

import { createCallerFactory } from "../trpc";
import { commentRouter } from "../routers/comment.router";

function callerFor(userId: string, orgId: string) {
  const prisma = {
    organizationMember: { findUnique: vi.fn(async () => ({ userId, organizationId: orgId, role: "OWNER" })) },
    postTarget: {
      findUnique: vi.fn(async () => ({
        id: "t",
        status: "PUBLISHED",
        format: null,
        publishedId: "SHARED_PAGE_1",
        publishedUrl: null,
        channelId: `c-${orgId}`,
        post: { organizationId: orgId },
      })),
    },
    channel: {
      findUnique: vi.fn(async () => ({
        id: `c-${orgId}`,
        organizationId: orgId,
        platform: "FACEBOOK",
        // The SAME Page, connected in two different workspaces.
        platformId: "SHARED_PAGE",
        name: "Shared Page",
        username: null,
        avatar: null,
        disconnectedAt: null,
        accessToken: "T",
        refreshToken: null,
        metadata: {},
      })),
    },
  } as any;
  return createCallerFactory(commentRouter)({
    prisma,
    session: { user: { id: userId, email: `${userId}@example.com`, isSuperAdmin: true } } as any,
    organizationId: orgId,
  });
}

describe("per-Page comment budgets", () => {
  it("caps replies to ONE Page at 30/min across users and orgs", async () => {
    const a = callerFor("user-a", "org-a");
    const b = callerFor("user-b", "org-b");
    for (let i = 0; i < 20; i++) await a.reply({ targetId: "t", commentId: "1_2", message: `a ${i}` });
    for (let i = 0; i < 10; i++) await b.reply({ targetId: "t", commentId: "1_2", message: `b ${i}` });
    expect(replyToComment).toHaveBeenCalledTimes(30);
    // user-b is only at 11/30 of their OWN limit — the Page budget is what stops it.
    await expect(b.reply({ targetId: "t", commentId: "1_2", message: "b 10" })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: expect.stringContaining("a lot of comment activity"),
    });
    expect(replyToComment).toHaveBeenCalledTimes(30);
  });

  it("rate-limits comment.list per user (60/min) before any Graph call", async () => {
    const c = callerFor("user-reader", "org-r");
    for (let i = 0; i < 60; i++) await c.list({ targetId: "t" });
    expect(getPostComments).toHaveBeenCalledTimes(60);
    await expect(c.list({ targetId: "t" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(getPostComments).toHaveBeenCalledTimes(60);
  });
});
