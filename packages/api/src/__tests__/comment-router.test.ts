/**
 * comment.list / comment.reply — org-scoping + the DECRYPT GOTCHA (2026-09-19).
 *
 * Exercises the REAL commentRouter through a tRPC caller with a fully-mocked
 * prisma and a mocked social provider. The actor is a superadmin so
 * orgProcedure's plan/billing checks pass without a DB; isSuperAdmin is ONLY a
 * plan exemption and does NOT relax the org-ownership scoping under test.
 *
 * The load-bearing assertion is the TWO-QUERY shape: the target is looked up
 * WITHOUT `include: { channel }`, and the channel is fetched by a DIRECT
 * `prisma.channel.findUnique` — the only read path that auto-decrypts
 * `accessToken`. Reading the channel through the PostTarget relation returns
 * `enc:v1:` ciphertext and every Graph call fails with "Cannot parse access
 * token" (the documented gotcha for every analytics/publish path).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getMediaComments = vi.fn();
const replyToComment = vi.fn();

vi.mock("@postautomation/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@postautomation/social")>();
  return {
    ...actual,
    getSocialProvider: vi.fn(() => ({ getMediaComments, replyToComment })),
  };
});

import { createCallerFactory } from "../trpc";
import { commentRouter } from "../routers/comment.router";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const TARGET_ID = "target-1";
const CHANNEL_ID = "channel-1";

function session() {
  return { user: { id: USER_ID, email: "u@example.com", isSuperAdmin: true } } as any;
}

function buildCaller(opts: {
  target?: Partial<{ status: string; publishedId: string | null; orgId: string; channelId: string }> | null;
  channel?: Partial<{ platform: string; disconnectedAt: Date | null; accessToken: string }> | null;
}) {
  const target =
    opts.target === null
      ? null
      : {
          id: TARGET_ID,
          status: "PUBLISHED",
          publishedId: "MEDIA_1",
          channelId: CHANNEL_ID,
          post: { organizationId: opts.target?.orgId ?? ORG_ID },
          ...(opts.target ?? {}),
        };
  const channel =
    opts.channel === null
      ? null
      : {
          id: CHANNEL_ID,
          platform: "INSTAGRAM",
          disconnectedAt: null,
          accessToken: "DECRYPTED_TOKEN",
          refreshToken: null,
          metadata: { igUserId: "IG_USER" },
          ...(opts.channel ?? {}),
        };

  const postTargetFindUnique = vi.fn(async (_args: any) => target);
  const channelFindUnique = vi.fn(async (_args: any) => channel);
  const prisma = {
    organizationMember: {
      findUnique: vi.fn(async () => ({ userId: USER_ID, organizationId: ORG_ID, role: "OWNER" })),
    },
    postTarget: { findUnique: postTargetFindUnique },
    channel: { findUnique: channelFindUnique },
  } as any;

  const caller = createCallerFactory(commentRouter)({ prisma, session: session(), organizationId: ORG_ID });
  return { caller, postTargetFindUnique, channelFindUnique };
}

beforeEach(() => {
  vi.clearAllMocks();
  getMediaComments.mockReset();
  replyToComment.mockReset();
});

describe("comment.list", () => {
  it("looks the target up WITHOUT the channel relation, then fetches the channel DIRECTLY (decrypt path)", async () => {
    getMediaComments.mockResolvedValue({ comments: [], nextCursor: null });
    const { caller, postTargetFindUnique, channelFindUnique } = buildCaller({});

    await caller.list({ targetId: TARGET_ID, after: "CURSOR" });

    const targetArgs = postTargetFindUnique.mock.calls[0]![0] as any;
    expect(targetArgs.where).toEqual({ id: TARGET_ID });
    expect(targetArgs.include).toBeUndefined();
    expect(targetArgs.select?.channel).toBeUndefined();
    // org-scoping reads the parent post's org, not a client-supplied value
    expect(targetArgs.select?.post).toEqual({ select: { organizationId: true } });

    expect(channelFindUnique).toHaveBeenCalledTimes(1);
    expect(channelFindUnique.mock.calls[0]![0]).toEqual({ where: { id: CHANNEL_ID } });

    // The DECRYPTED token + the target's own media id + the caller's cursor reach the provider.
    expect(getMediaComments).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "DECRYPTED_TOKEN", metadata: { igUserId: "IG_USER" } }),
      "MEDIA_1",
      "CURSOR"
    );
  });

  it("rejects a target belonging to ANOTHER org as NOT_FOUND before any channel read or Graph call", async () => {
    const { caller, channelFindUnique } = buildCaller({ target: { orgId: "org-other" } });
    await expect(caller.list({ targetId: TARGET_ID })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(channelFindUnique).not.toHaveBeenCalled();
    expect(getMediaComments).not.toHaveBeenCalled();
  });

  it("rejects an unknown target as NOT_FOUND", async () => {
    const { caller } = buildCaller({ target: null });
    await expect(caller.list({ targetId: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getMediaComments).not.toHaveBeenCalled();
  });

  it("refuses a target that has not published yet (no media to read comments from)", async () => {
    const { caller } = buildCaller({ target: { status: "SCHEDULED", publishedId: null } });
    await expect(caller.list({ targetId: TARGET_ID })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(getMediaComments).not.toHaveBeenCalled();
  });

  it("refuses a PUBLISHED target with no publishedId (cannot address the media)", async () => {
    const { caller } = buildCaller({ target: { publishedId: null } });
    await expect(caller.list({ targetId: TARGET_ID })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a non-Instagram channel", async () => {
    const { caller } = buildCaller({ channel: { platform: "FACEBOOK" } });
    await expect(caller.list({ targetId: TARGET_ID })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(getMediaComments).not.toHaveBeenCalled();
  });

  it("refuses a disconnected channel (its token is the DISCONNECTED sentinel)", async () => {
    const { caller } = buildCaller({ channel: { disconnectedAt: new Date("2026-09-01") } });
    await expect(caller.list({ targetId: TARGET_ID })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(getMediaComments).not.toHaveBeenCalled();
  });

  it("surfaces the provider's actionable message (permission / gone) as BAD_REQUEST", async () => {
    getMediaComments.mockRejectedValue(new Error("This Instagram account hasn't been granted comment-reply permission yet."));
    const { caller } = buildCaller({});
    await expect(caller.list({ targetId: TARGET_ID })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("comment-reply permission"),
    });
  });
});

describe("comment.reply", () => {
  it("applies the SAME org/platform/publish gate as list, then replies with the decrypted token", async () => {
    replyToComment.mockResolvedValue({ id: "REPLY_1" });
    const { caller, channelFindUnique } = buildCaller({});

    const res = await caller.reply({ targetId: TARGET_ID, commentId: "COMMENT_1", message: "  Thanks!  " });

    expect(res).toEqual({ id: "REPLY_1" });
    expect(channelFindUnique.mock.calls[0]![0]).toEqual({ where: { id: CHANNEL_ID } });
    // zod .trim() runs before the provider sees it
    expect(replyToComment).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "DECRYPTED_TOKEN" }),
      "COMMENT_1",
      "Thanks!"
    );
  });

  it("cannot bypass the gate by calling reply directly on a foreign target", async () => {
    const { caller } = buildCaller({ target: { orgId: "org-other" } });
    await expect(
      caller.reply({ targetId: TARGET_ID, commentId: "COMMENT_1", message: "hi" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(replyToComment).not.toHaveBeenCalled();
  });

  it("rejects an empty / whitespace-only reply before any Graph call", async () => {
    const { caller } = buildCaller({});
    await expect(caller.reply({ targetId: TARGET_ID, commentId: "C", message: "   " })).rejects.toThrow();
    expect(replyToComment).not.toHaveBeenCalled();
  });

  it("rejects a reply over Instagram's 2200-character ceiling before any Graph call", async () => {
    const { caller } = buildCaller({});
    await expect(
      caller.reply({ targetId: TARGET_ID, commentId: "C", message: "x".repeat(2201) })
    ).rejects.toThrow();
    expect(replyToComment).not.toHaveBeenCalled();
  });

  it("refuses to reply through a non-Instagram or disconnected channel", async () => {
    const fb = buildCaller({ channel: { platform: "FACEBOOK" } });
    await expect(fb.caller.reply({ targetId: TARGET_ID, commentId: "C", message: "hi" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const gone = buildCaller({ channel: { disconnectedAt: new Date() } });
    await expect(gone.caller.reply({ targetId: TARGET_ID, commentId: "C", message: "hi" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(replyToComment).not.toHaveBeenCalled();
  });
});
