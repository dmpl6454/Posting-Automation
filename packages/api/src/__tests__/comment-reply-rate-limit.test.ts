/**
 * comment.reply is rate-limited per user (30/min, commentReplyRateLimiter).
 * Replies are PUBLIC posts made as the org's Page / IG account; a burst of them
 * trips Meta's spam classifier (#368) on the Page and weighs on the shared app.
 * Separate file so the module-level limiter state starts fresh.
 */
import { describe, it, expect, vi } from "vitest";

const replyToComment = vi.fn(async () => ({ id: "R" }));

vi.mock("@postautomation/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@postautomation/social")>();
  return { ...actual, getSocialProvider: vi.fn(() => ({ replyToComment })) };
});
vi.mock("../lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/audit")>();
  return { ...actual, createAuditLog: vi.fn(async () => {}) };
});

import { createCallerFactory } from "../trpc";
import { commentRouter } from "../routers/comment.router";

describe("comment.reply rate limit", () => {
  it("allows 30 replies a minute per user, then refuses with TOO_MANY_REQUESTS before any Graph call", async () => {
    const prisma = {
      organizationMember: { findUnique: vi.fn(async () => ({ userId: "u-rl", organizationId: "o", role: "OWNER" })) },
      postTarget: {
        findUnique: vi.fn(async () => ({
          id: "t",
          status: "PUBLISHED",
          format: null,
          publishedId: "P_1",
          publishedUrl: null,
          channelId: "c",
          post: { organizationId: "o" },
        })),
      },
      channel: {
        findUnique: vi.fn(async () => ({
          id: "c",
          platform: "FACEBOOK",
          platformId: "P",
          name: "Page",
          username: null,
          avatar: null,
          disconnectedAt: null,
          accessToken: "T",
          refreshToken: null,
          metadata: {},
        })),
      },
    } as any;
    const caller = createCallerFactory(commentRouter)({
      prisma,
      session: { user: { id: "u-rl", email: "rl@example.com", isSuperAdmin: true } } as any,
      organizationId: "o",
    });

    for (let i = 0; i < 30; i++) {
      await caller.reply({ targetId: "t", commentId: "1_2", message: `thanks ${i}` });
    }
    expect(replyToComment).toHaveBeenCalledTimes(30);

    await expect(caller.reply({ targetId: "t", commentId: "1_2", message: "one too many" })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(replyToComment).toHaveBeenCalledTimes(30);
  });
});
