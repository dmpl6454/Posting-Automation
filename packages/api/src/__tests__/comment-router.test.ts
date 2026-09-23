/**
 * comment.* — org-scoping, the DECRYPT GOTCHA, and Facebook + Instagram routing
 * (IG 2026-09-19, FB 2026-09-23).
 *
 * Exercises the REAL commentRouter through a tRPC caller with a fully-mocked
 * prisma and mocked social providers. The actor is a superadmin so
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
const igReplyToComment = vi.fn();
const getCommentMediaId = vi.fn();
const igSetHidden = vi.fn(async () => {});
const igDelete = vi.fn(async () => {});
const getPostComments = vi.fn();
const fbReplyToComment = vi.fn();
const fbSetHidden = vi.fn(async () => {});
const fbDelete = vi.fn(async () => {});
const fbSetLiked = vi.fn(async () => {});
const fbEdit = vi.fn(async () => {});
const fetchMetaTokenWindow = vi.fn();
const createAuditLog = vi.fn(async (_input: any) => {});

vi.mock("@postautomation/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@postautomation/social")>();
  return {
    ...actual,
    fetchMetaTokenWindow: (...args: any[]) => fetchMetaTokenWindow(...args),
    resolveMetaCredentials: vi.fn(() => ({ appId: "APP", clientId: "APP", clientSecret: "SECRET", legacy: true })),
    getSocialProvider: vi.fn((platform: string) =>
      platform === "FACEBOOK"
        ? {
            getPostComments,
            replyToComment: fbReplyToComment,
            setCommentHidden: fbSetHidden,
            deleteComment: fbDelete,
            setCommentLiked: fbSetLiked,
            editComment: fbEdit,
          }
        : {
            getMediaComments,
            replyToComment: igReplyToComment,
            getCommentMediaId,
            setCommentHidden: igSetHidden,
            deleteComment: igDelete,
          }
    ),
  };
});

// The real helper writes through the global prisma client — never let a unit
// test reach for a database.
vi.mock("../lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/audit")>();
  return { ...actual, createAuditLog: (input: any) => createAuditLog(input) };
});

import { createCallerFactory } from "../trpc";
import { commentRouter } from "../routers/comment.router";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const TARGET_ID = "target-1";
const CHANNEL_ID = "channel-1";
const EMPTY_PAGE = { comments: [], nextCursor: null, totalCount: null };

function session() {
  return { user: { id: USER_ID, email: "u@example.com", isSuperAdmin: true } } as any;
}

function buildCaller(opts: {
  target?: Partial<{
    status: string;
    format: string | null;
    publishedId: string | null;
    publishedUrl: string | null;
    orgId: string;
    channelId: string;
  }> | null;
  channel?: Partial<{
    organizationId: string;
    platform: string;
    disconnectedAt: Date | null;
    accessToken: string;
    platformId: string;
    name: string;
    username: string | null;
    metadata: any;
  }> | null;
  channels?: any[];
  groupByRows?: any[];
  findFirstChannel?: any;
  targetRows?: any[];
}) {
  const target =
    opts.target === null
      ? null
      : {
          id: TARGET_ID,
          status: "PUBLISHED",
          format: null,
          publishedId: "MEDIA_1",
          publishedUrl: "https://www.instagram.com/p/abc/",
          channelId: CHANNEL_ID,
          post: { organizationId: opts.target?.orgId ?? ORG_ID },
          ...(opts.target ?? {}),
        };
  const channel =
    opts.channel === null
      ? null
      : {
          id: CHANNEL_ID,
          organizationId: ORG_ID,
          platform: "INSTAGRAM",
          platformId: "IG_USER",
          name: "Bollywood Daily",
          username: "bollywooddaily",
          avatar: null,
          disconnectedAt: null,
          accessToken: "DECRYPTED_TOKEN",
          refreshToken: null,
          metadata: { igUserId: "IG_USER" },
          ...(opts.channel ?? {}),
        };

  const postTargetFindUnique = vi.fn(async (_args: any) => target);
  const channelFindUnique = vi.fn(async (_args: any) => channel);
  const channelFindMany = vi.fn(async (_args: any) => opts.channels ?? []);
  const channelFindFirst = vi.fn(async (_args: any) => opts.findFirstChannel ?? null);
  const postTargetGroupBy = vi.fn(async (_args: any) => opts.groupByRows ?? []);
  const postTargetFindMany = vi.fn(async (_args: any) => opts.targetRows ?? []);
  const executeRaw = vi.fn(async () => 1);
  const prisma = {
    $executeRaw: executeRaw,
    organizationMember: {
      findUnique: vi.fn(async () => ({ userId: USER_ID, organizationId: ORG_ID, role: "OWNER" })),
    },
    postTarget: { findUnique: postTargetFindUnique, groupBy: postTargetGroupBy, findMany: postTargetFindMany },
    channel: { findUnique: channelFindUnique, findMany: channelFindMany, findFirst: channelFindFirst },
  } as any;

  const caller = createCallerFactory(commentRouter)({ prisma, session: session(), organizationId: ORG_ID });
  return {
    caller,
    postTargetFindUnique,
    channelFindUnique,
    channelFindMany,
    channelFindFirst,
    postTargetGroupBy,
    postTargetFindMany,
    executeRaw,
  };
}

const FB_PAGE = "112035290218472";
const FB_CHANNEL = {
  platform: "FACEBOOK",
  platformId: FB_PAGE,
  name: "Contents of bollywood",
  username: null,
  metadata: { pageId: FB_PAGE },
};
/** A Page post `{pageId}_{postId}` — its comments are `9_{commentId}` (live-verified shape). */
const FB_TARGET = { publishedId: `${FB_PAGE}_9` };
const FRESH = new Date().toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  getMediaComments.mockReset();
  igReplyToComment.mockReset();
  getPostComments.mockReset();
  fbReplyToComment.mockReset();
  getCommentMediaId.mockReset();
  // By default the IG comment sits on the target's own media (MEDIA_1).
  getCommentMediaId.mockResolvedValue("MEDIA_1");
  fetchMetaTokenWindow.mockReset();
  fetchMetaTokenWindow.mockResolvedValue(null);
});

describe("comment.list", () => {
  it("looks the target up WITHOUT the channel relation, then fetches the channel DIRECTLY (decrypt path)", async () => {
    getMediaComments.mockResolvedValue(EMPTY_PAGE);
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

    // The DECRYPTED token + the target's own media id + the caller's cursor +
    // the account identity (for flagging our own replies) reach the provider.
    expect(getMediaComments).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "DECRYPTED_TOKEN", metadata: { igUserId: "IG_USER" } }),
      "MEDIA_1",
      "CURSOR",
      { igUserId: "IG_USER", username: "bollywooddaily" }
    );
  });

  it("prefers `cursor` (useInfiniteQuery) over the legacy `after`", async () => {
    getMediaComments.mockResolvedValue(EMPTY_PAGE);
    const { caller } = buildCaller({});
    await caller.list({ targetId: TARGET_ID, cursor: "NEW", after: "OLD" });
    expect(getMediaComments.mock.calls[0]![2]).toBe("NEW");
  });

  it("returns the thread's platform, account identity and post URL with the page", async () => {
    getMediaComments.mockResolvedValue({ comments: [], nextCursor: "N", totalCount: null });
    const { caller } = buildCaller({});
    const res = await caller.list({ targetId: TARGET_ID });
    expect(res).toMatchObject({
      platform: "INSTAGRAM",
      publishedUrl: "https://www.instagram.com/p/abc/",
      account: { channelId: CHANNEL_ID, name: "Bollywood Daily", username: "bollywooddaily" },
      nextCursor: "N",
    });
  });

  it("routes a FACEBOOK target to getPostComments with the Page id (flags the Page's own replies)", async () => {
    getPostComments.mockResolvedValue({ comments: [], nextCursor: null, totalCount: 3 });
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    const res = await caller.list({ targetId: TARGET_ID });
    expect(getPostComments).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "DECRYPTED_TOKEN" }),
      `${FB_PAGE}_9`,
      FB_PAGE,
      undefined
    );
    expect(getMediaComments).not.toHaveBeenCalled();
    expect(res).toMatchObject({ platform: "FACEBOOK", totalCount: 3, account: { name: "Contents of bollywood" } });
  });

  it("reads a Facebook VIDEO target's comments on its bare Video-node id", async () => {
    getPostComments.mockResolvedValue(EMPTY_PAGE);
    const { caller } = buildCaller({ target: { publishedId: "1748002179986936" }, channel: FB_CHANNEL });
    await caller.list({ targetId: TARGET_ID });
    expect(getPostComments.mock.calls[0]![1]).toBe("1748002179986936");
  });

  it("rejects a target belonging to ANOTHER org as NOT_FOUND before any channel read or Graph call", async () => {
    const { caller, channelFindUnique } = buildCaller({ target: { orgId: "org-other" } });
    await expect(caller.list({ targetId: TARGET_ID })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(channelFindUnique).not.toHaveBeenCalled();
    expect(getMediaComments).not.toHaveBeenCalled();
    expect(getPostComments).not.toHaveBeenCalled();
  });

  it("refuses a channel row belonging to ANOTHER org even if a target points at it (defence in depth)", async () => {
    const { caller } = buildCaller({ channel: { organizationId: "org-other" } });
    await expect(caller.list({ targetId: TARGET_ID })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.reply({ targetId: TARGET_ID, commentId: "17900000000000001", message: "hi" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getMediaComments).not.toHaveBeenCalled();
    expect(igReplyToComment).not.toHaveBeenCalled();
  });

  it("rejects an unknown target as NOT_FOUND", async () => {
    const { caller } = buildCaller({ target: null });
    await expect(caller.list({ targetId: "nope" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getMediaComments).not.toHaveBeenCalled();
  });

  it("refuses a target that has not published yet (nothing to read comments from)", async () => {
    const { caller } = buildCaller({ target: { status: "SCHEDULED", publishedId: null } });
    await expect(caller.list({ targetId: TARGET_ID })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(getMediaComments).not.toHaveBeenCalled();
  });

  it("refuses a PUBLISHED target with no publishedId (cannot address the post)", async () => {
    const { caller } = buildCaller({ target: { publishedId: null } });
    await expect(caller.list({ targetId: TARGET_ID })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a channel on a platform without a comments integration", async () => {
    for (const platform of ["TWITTER", "LINKEDIN", "YOUTUBE", "THREADS"]) {
      const { caller } = buildCaller({ channel: { platform } });
      await expect(caller.list({ targetId: TARGET_ID })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("Facebook Pages and Instagram accounts"),
      });
    }
    expect(getMediaComments).not.toHaveBeenCalled();
    expect(getPostComments).not.toHaveBeenCalled();
  });

  it("refuses a disconnected channel (its token is the DISCONNECTED sentinel)", async () => {
    for (const channel of [{ disconnectedAt: new Date("2026-09-01") }, { ...FB_CHANNEL, disconnectedAt: new Date() }]) {
      const { caller } = buildCaller({ channel });
      await expect(caller.list({ targetId: TARGET_ID })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(getMediaComments).not.toHaveBeenCalled();
    expect(getPostComments).not.toHaveBeenCalled();
  });

  it("surfaces the provider's actionable message (permission / gone) as BAD_REQUEST", async () => {
    getPostComments.mockRejectedValue(new Error("This Facebook Page hasn't granted comment access yet."));
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    await expect(caller.list({ targetId: TARGET_ID })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("hasn't granted comment access"),
    });
  });
});

describe("comment.reply", () => {
  it("Instagram: applies the SAME org/platform/publish gate as list, then replies with the decrypted token", async () => {
    igReplyToComment.mockResolvedValue({ id: "REPLY_1" });
    const { caller, channelFindUnique } = buildCaller({});

    const res = await caller.reply({ targetId: TARGET_ID, commentId: "17900000000000001", message: "  Thanks!  " });

    expect(res).toEqual({ id: "REPLY_1", platform: "INSTAGRAM" });
    expect(channelFindUnique.mock.calls[0]![0]).toEqual({ where: { id: CHANNEL_ID } });
    // zod .trim() runs before the provider sees it
    expect(igReplyToComment).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "DECRYPTED_TOKEN" }),
      "17900000000000001",
      "Thanks!"
    );
    expect(fbReplyToComment).not.toHaveBeenCalled();
  });

  it("Facebook: replies AS THE PAGE through the Facebook provider with the Page id", async () => {
    fbReplyToComment.mockResolvedValue({ id: "9_77" });
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    const res = await caller.reply({ targetId: TARGET_ID, commentId: "9_55", message: "Thank you!" });
    expect(res).toEqual({ id: "9_77", platform: "FACEBOOK" });
    expect(fbReplyToComment).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "DECRYPTED_TOKEN" }),
      "9_55",
      "Thank you!",
      FB_PAGE
    );
    expect(igReplyToComment).not.toHaveBeenCalled();
  });

  it("audit-logs a successful reply with who/where — never the reply text", async () => {
    fbReplyToComment.mockResolvedValue({ id: "9_77" });
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    await caller.reply({ targetId: TARGET_ID, commentId: "9_55", message: "a private-ish message" });

    expect(createAuditLog).toHaveBeenCalledTimes(1);
    const entry = createAuditLog.mock.calls[0]![0];
    expect(entry).toMatchObject({
      organizationId: ORG_ID,
      userId: USER_ID,
      action: "comment.replied",
      entityType: "PostTarget",
      entityId: TARGET_ID,
      metadata: { platform: "FACEBOOK", channelId: CHANNEL_ID, commentId: "9_55", replyId: "9_77" },
    });
    expect(JSON.stringify(entry)).not.toContain("private-ish");
  });

  it("does NOT audit a reply the platform definitely refused", async () => {
    fbReplyToComment.mockRejectedValue(new Error("Facebook couldn't post that reply right now."));
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    await expect(caller.reply({ targetId: TARGET_ID, commentId: "9_55", message: "hi" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(createAuditLog).not.toHaveBeenCalled();
  });

  it("DOES audit a reply whose outcome is unknown — it may be live, so the trail must exist", async () => {
    fbReplyToComment.mockRejectedValue(new Error("Facebook accepted the reply but did not confirm it. … may already be posted."));
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    await expect(caller.reply({ targetId: TARGET_ID, commentId: "9_55", message: "a private-ish reply" })).rejects.toMatchObject({
      message: expect.stringContaining("may already be posted"),
    });
    expect(createAuditLog).toHaveBeenCalledTimes(1);
    expect(createAuditLog.mock.calls[0]![0]).toMatchObject({ action: "comment.replied", metadata: { outcome: "unconfirmed" } });
    expect(JSON.stringify(createAuditLog.mock.calls)).not.toContain("private-ish");
  });

  it("cannot bypass the gate by calling reply directly on a foreign target", async () => {
    const { caller } = buildCaller({ target: { orgId: "org-other" } });
    await expect(
      caller.reply({ targetId: TARGET_ID, commentId: "17900000000000001", message: "hi" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(igReplyToComment).not.toHaveBeenCalled();
    expect(fbReplyToComment).not.toHaveBeenCalled();
  });

  it("rejects an empty / whitespace-only reply before any Graph call", async () => {
    const { caller } = buildCaller({});
    await expect(caller.reply({ targetId: TARGET_ID, commentId: "17900000000000001", message: "   " })).rejects.toThrow();
    expect(igReplyToComment).not.toHaveBeenCalled();
  });

  it("enforces Instagram's 2200-character ceiling but lets a Facebook reply use Facebook's", async () => {
    const ig = buildCaller({});
    await expect(
      ig.caller.reply({ targetId: TARGET_ID, commentId: "17900000000000001", message: "x".repeat(2201) })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("2,200") });
    expect(igReplyToComment).not.toHaveBeenCalled();

    fbReplyToComment.mockResolvedValue({ id: "R" });
    const fb = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    await fb.caller.reply({ targetId: TARGET_ID, commentId: "9_55", message: "x".repeat(2201) });
    expect(fbReplyToComment).toHaveBeenCalledTimes(1);

    await expect(
      fb.caller.reply({ targetId: TARGET_ID, commentId: "9_55", message: "x".repeat(8001) })
    ).rejects.toThrow();
    expect(fbReplyToComment).toHaveBeenCalledTimes(1);
  });

  it("refuses to reply through an unsupported-platform or disconnected channel", async () => {
    const tw = buildCaller({ channel: { platform: "TWITTER" } });
    await expect(tw.caller.reply({ targetId: TARGET_ID, commentId: "17900000000000001", message: "hi" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const gone = buildCaller({ target: FB_TARGET, channel: { ...FB_CHANNEL, disconnectedAt: new Date() } });
    await expect(gone.caller.reply({ targetId: TARGET_ID, commentId: "9_55", message: "hi" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(igReplyToComment).not.toHaveBeenCalled();
    expect(fbReplyToComment).not.toHaveBeenCalled();
  });
});

describe("comment.reply — commentId is the only client value reaching a Graph URL path", () => {
  it("🔴 REJECTS the arbitrary-authenticated-POST payload before any Graph call", async () => {
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    await expect(
      caller.reply({
        targetId: TARGET_ID,
        // Raw-interpolated this retargets the POST to another edge (e.g. the
        // Page feed) on the org's own Page token.
        commentId: "112035290218472/feed?message=Hacked&x=",
        message: "hi",
      })
    ).rejects.toThrow();
    expect(fbReplyToComment).not.toHaveBeenCalled();
  });

  it("rejects any id containing a path/query breakout character", async () => {
    const { caller } = buildCaller({});
    for (const bad of ["123/media", "123?fields=x", "123&method=delete", "123%2Fmedia", "abc", "../me"]) {
      await expect(caller.reply({ targetId: TARGET_ID, commentId: bad, message: "hi" })).rejects.toThrow();
    }
    expect(igReplyToComment).not.toHaveBeenCalled();
  });

  it("still accepts a legitimate composite {object}_{comment} id", async () => {
    fbReplyToComment.mockResolvedValue({ id: "REPLY_1" });
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    await caller.reply({ targetId: TARGET_ID, commentId: "9_9988776655", message: "hi" });
    expect(fbReplyToComment).toHaveBeenCalledWith(expect.anything(), "9_9988776655", "hi", FB_PAGE);
  });
});

describe("stories have no comments edge", () => {
  it("refuses list on an Instagram STORY-format target", async () => {
    const { caller } = buildCaller({ target: { format: "STORY" } });
    await expect(caller.list({ targetId: TARGET_ID })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Instagram stories don't have comments"),
    });
    expect(getMediaComments).not.toHaveBeenCalled();
  });

  it("refuses list on a Facebook STORY-format target with Facebook wording", async () => {
    const { caller } = buildCaller({ target: { format: "STORY" }, channel: FB_CHANNEL });
    await expect(caller.list({ targetId: TARGET_ID })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Facebook stories don't have comments"),
    });
    expect(getPostComments).not.toHaveBeenCalled();
  });

  it("refuses reply on a STORY-format target", async () => {
    const { caller } = buildCaller({ target: { format: "STORY" } });
    await expect(
      caller.reply({ targetId: TARGET_ID, commentId: "17900000000000001", message: "hi" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(igReplyToComment).not.toHaveBeenCalled();
  });

  it("still allows a REEL / feed target", async () => {
    getMediaComments.mockResolvedValue(EMPTY_PAGE);
    const { caller } = buildCaller({ target: { format: "REEL" } });
    await caller.list({ targetId: TARGET_ID });
    expect(getMediaComments).toHaveBeenCalled();
  });
});

describe("comment.accounts", () => {
  it("lists ONLY this org's live Facebook/Instagram channels, most recently published first", async () => {
    const { caller, channelFindMany, postTargetGroupBy } = buildCaller({
      channels: [
        { id: "c-old", platform: "FACEBOOK", name: "B Page", username: null, avatar: null, isActive: true },
        { id: "c-new", platform: "INSTAGRAM", name: "A Insta", username: "a", avatar: null, isActive: true },
        { id: "c-none", platform: "FACEBOOK", name: "C Page", username: null, avatar: null, isActive: false },
      ],
      groupByRows: [
        { channelId: "c-old", _count: { _all: 2 }, _max: { publishedAt: new Date("2026-09-01") } },
        { channelId: "c-new", _count: { _all: 5 }, _max: { publishedAt: new Date("2026-09-20") } },
      ],
    });

    const res = await caller.accounts();

    const where = channelFindMany.mock.calls[0]![0].where;
    expect(where).toEqual({
      organizationId: ORG_ID,
      disconnectedAt: null,
      platform: { in: ["FACEBOOK", "INSTAGRAM"] },
    });
    // Never select the token for a list of accounts.
    expect(channelFindMany.mock.calls[0]![0].select.accessToken).toBeUndefined();

    expect(res.map((a: any) => [a.id, a.publishedPosts])).toEqual([
      ["c-new", 5],
      ["c-old", 2],
      ["c-none", 0],
    ]);

    const gb = postTargetGroupBy.mock.calls[0]![0];
    expect(gb.where.post).toEqual({ organizationId: ORG_ID });
    expect(gb.where.status).toBe("PUBLISHED");
  });

  it("counts NULL-format posts (the NULL trap): the story filter states the NULL branch explicitly", async () => {
    const { caller, postTargetGroupBy } = buildCaller({
      channels: [{ id: "c1", platform: "FACEBOOK", name: "P", username: null, avatar: null, isActive: true }],
    });
    await caller.accounts();
    const or = postTargetGroupBy.mock.calls[0]![0].where.OR;
    // `format: { not: "STORY" }` alone compiles to format <> 'STORY', which
    // drops every NULL-format row — i.e. nearly every feed post.
    expect(or).toEqual([{ format: null }, { format: { not: "STORY" } }]);
  });

  it("returns [] without a groupBy when the org has no Meta channels", async () => {
    const { caller, postTargetGroupBy } = buildCaller({ channels: [] });
    expect(await caller.accounts()).toEqual([]);
    expect(postTargetGroupBy).not.toHaveBeenCalled();
  });
});

describe("comment.posts", () => {
  it("rejects a channel outside this org as NOT_FOUND (org-scoped findFirst)", async () => {
    const { caller, channelFindFirst, postTargetFindMany } = buildCaller({ findFirstChannel: null });
    await expect(caller.posts({ channelId: "foreign" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(channelFindFirst.mock.calls[0]![0].where).toEqual({
      id: "foreign",
      organizationId: ORG_ID,
      disconnectedAt: null,
    });
    expect(postTargetFindMany).not.toHaveBeenCalled();
  });

  it("rejects a non-Meta channel", async () => {
    const { caller } = buildCaller({
      findFirstChannel: { id: "c1", platform: "LINKEDIN", name: "L", username: null, avatar: null },
    });
    await expect(caller.posts({ channelId: "c1" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("lists published non-story posts newest first, never handing a VIDEO file to <img>", async () => {
    const row = (id: string, fileType: string | null, thumbnailUrl: string | null = null) => ({
      id,
      format: null,
      publishedAt: new Date("2026-09-20"),
      publishedUrl: `https://facebook.com/${id}`,
      contentOverride: null,
      post: {
        id: `p-${id}`,
        content: "Caption " + id,
        mediaAttachments: fileType
          ? [{ media: { url: `https://cdn/${id}.${fileType.startsWith("video") ? "mp4" : "jpg"}`, thumbnailUrl, fileType } }]
          : [],
      },
    });
    const { caller, postTargetFindMany } = buildCaller({
      findFirstChannel: { id: "c1", platform: "FACEBOOK", name: "P", username: null, avatar: null },
      targetRows: [row("t1", "image/jpeg"), row("t2", "video/mp4"), row("t3", "video/mp4", "https://cdn/t3-thumb.jpg")],
    });

    const res = await caller.posts({ channelId: "c1", limit: 2 });

    const args = postTargetFindMany.mock.calls[0]![0];
    expect(args.where).toMatchObject({
      channelId: "c1",
      post: { organizationId: ORG_ID },
      status: "PUBLISHED",
      publishedId: { not: null },
      OR: [{ format: null }, { format: { not: "STORY" } }],
    });
    expect(args.orderBy).toEqual([{ publishedAt: "desc" }, { id: "desc" }]);
    expect(args.take).toBe(3); // limit + 1 to detect a next page

    expect(res.items).toHaveLength(2);
    expect(res.items[0]).toMatchObject({ targetId: "t1", mediaKind: "image", thumbnailUrl: "https://cdn/t1.jpg" });
    // A video with no thumbnail must NOT fall back to the .mp4 URL.
    expect(res.items[1]).toMatchObject({ targetId: "t2", mediaKind: "video", thumbnailUrl: null });
    expect(res.nextCursor).toBe("t2");
  });
});


describe("capabilities — what the channel's token was actually GRANTED", () => {
  const OLD_IG = ["instagram_basic", "pages_read_engagement", "pages_show_list", "business_management"];

  it("uses the grant recorded at connect — no extra Graph call", async () => {
    getMediaComments.mockResolvedValue(EMPTY_PAGE);
    const { caller, executeRaw } = buildCaller({ channel: { metadata: { igUserId: "IG_USER", grantedScopes: OLD_IG, grantedScopesCheckedAt: FRESH } } });
    const res = await caller.list({ targetId: TARGET_ID });
    expect(fetchMetaTokenWindow).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
    expect(res.capabilities).toMatchObject({ known: true, canReply: false, namesHidden: true, missing: ["instagram_manage_comments"] });
  });

  it("checks ONCE (debug_token) for a channel connected before grants were recorded, and remembers it with an atomic merge", async () => {
    getPostComments.mockResolvedValue(EMPTY_PAGE);
    fetchMetaTokenWindow.mockResolvedValue({ valid: true, scopes: ["pages_read_engagement", "pages_read_user_content", "pages_show_list"] });
    const { caller, executeRaw } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    const res = await caller.list({ targetId: TARGET_ID });
    expect(fetchMetaTokenWindow).toHaveBeenCalledWith("DECRYPTED_TOKEN", "APP", "SECRET");
    // jsonb MERGE (metadata || patch) — never a whole-column rewrite that could
    // drop the worker's concurrent insightsHealth write.
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const sql = (executeRaw.mock.calls[0] as any)[0].join("?");
    expect(sql).toMatch(/COALESCE\("metadata", '\{\}'::jsonb\) \|\|/);
    expect(res.capabilities).toMatchObject({ known: true, canRead: true, canReply: false, missing: ["pages_manage_engagement"] });
  });

  it("never records a DEAD token's empty scope list as a grant (the fault is the token, not a permission)", async () => {
    getPostComments.mockResolvedValue(EMPTY_PAGE);
    fetchMetaTokenWindow.mockResolvedValue({ valid: false, scopes: [] });
    const { caller, executeRaw } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    const res = await caller.list({ targetId: TARGET_ID });
    expect(executeRaw).not.toHaveBeenCalled();
    expect(res.capabilities).toMatchObject({ known: false });
  });

  it("does not re-check on 'load more' pages", async () => {
    getPostComments.mockResolvedValue(EMPTY_PAGE);
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    await caller.list({ targetId: TARGET_ID, cursor: "NEXT" });
    expect(fetchMetaTokenWindow).not.toHaveBeenCalled();
  });

  it("an unknown grant (check failed) is reported as unknown, never guessed", async () => {
    getPostComments.mockResolvedValue(EMPTY_PAGE);
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    const res = await caller.list({ targetId: TARGET_ID });
    expect(res.capabilities).toMatchObject({ known: false, canReply: null });
  });

  it("re-checks the grant when Meta refuses a call for a missing permission", async () => {
    getPostComments.mockRejectedValue(new Error("This Facebook Page hasn't granted comment access yet."));
    const { caller } = buildCaller({
      target: FB_TARGET,
      channel: { ...FB_CHANNEL, metadata: { grantedScopes: ["pages_manage_engagement", "pages_read_engagement", "pages_read_user_content"], grantedScopesCheckedAt: FRESH } },
    });
    await expect(caller.list({ targetId: TARGET_ID })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMetaTokenWindow).toHaveBeenCalledTimes(1);
  });

  it("comment.accounts derives commentAccess from the cached grant and never returns raw metadata", async () => {
    const { caller } = buildCaller({
      channels: [
        { id: "c1", platform: "INSTAGRAM", name: "IG", username: "ig", avatar: null, isActive: true, metadata: { igUserId: "X", grantedScopes: OLD_IG } },
        { id: "c2", platform: "FACEBOOK", name: "FB", username: null, avatar: null, isActive: true, metadata: { pageId: "P", userAccessToken: "enc:v1:secret" } },
      ],
    });
    const res: any[] = await caller.accounts();
    const ig = res.find((a) => a.id === "c1");
    const fb = res.find((a) => a.id === "c2");
    expect(ig.commentAccess).toMatchObject({ known: true, canReply: false });
    expect(fb.commentAccess).toMatchObject({ known: false });
    expect(JSON.stringify(res)).not.toContain("userAccessToken");
    expect(ig.metadata).toBeUndefined();
  });
});

describe("🔒 Instagram writes are scoped to the target's OWN media", () => {
  it("refuses to reply to a comment that belongs to other media (a user token spans accounts)", async () => {
    getCommentMediaId.mockResolvedValue("SOMEONE_ELSES_MEDIA");
    const { caller } = buildCaller({});
    await expect(caller.reply({ targetId: TARGET_ID, commentId: "17900000000000001", message: "hi" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(igReplyToComment).not.toHaveBeenCalled();
  });

  it("a comment that no longer exists is a clean 'refresh' error, not a reply attempt", async () => {
    getCommentMediaId.mockResolvedValue(null);
    const { caller } = buildCaller({});
    await expect(caller.reply({ targetId: TARGET_ID, commentId: "17900000000000001", message: "hi" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("no longer exists"),
    });
    expect(igReplyToComment).not.toHaveBeenCalled();
  });

  it("Facebook needs no Graph lookup — the comment id itself proves which post it is on", async () => {
    fbReplyToComment.mockResolvedValue({ id: "R" });
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    await caller.reply({ targetId: TARGET_ID, commentId: "9_55", message: "hi" });
    expect(getCommentMediaId).not.toHaveBeenCalled();
  });
});

describe("comment.moderate", () => {
  it("routes every Facebook action to the provider as the Page", async () => {
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    await caller.moderate({ targetId: TARGET_ID, commentId: "9_1", action: "hide" });
    await caller.moderate({ targetId: TARGET_ID, commentId: "9_1", action: "unhide" });
    await caller.moderate({ targetId: TARGET_ID, commentId: "9_1", action: "like" });
    await caller.moderate({ targetId: TARGET_ID, commentId: "9_1", action: "unlike" });
    await caller.moderate({ targetId: TARGET_ID, commentId: "9_2", action: "edit", message: "  New text " });
    await caller.moderate({ targetId: TARGET_ID, commentId: "9_1", action: "delete" });
    expect(fbSetHidden.mock.calls.map((c: any[]) => [c[1], c[2], c[3]])).toEqual([["9_1", true, FB_PAGE], ["9_1", false, FB_PAGE]]);
    expect(fbSetLiked.mock.calls.map((c: any[]) => c[2])).toEqual([true, false]);
    expect(fbEdit).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "DECRYPTED_TOKEN" }), "9_2", "New text", FB_PAGE);
    expect(fbDelete).toHaveBeenCalledWith(expect.anything(), "9_1", FB_PAGE);
  });

  it("audit-logs each action with who/where — never the comment text", async () => {
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    await caller.moderate({ targetId: TARGET_ID, commentId: "9_2", action: "edit", message: "secret words" });
    await caller.moderate({ targetId: TARGET_ID, commentId: "9_1", action: "delete" });
    expect(createAuditLog.mock.calls.map((c: any[]) => c[0].action)).toEqual(["comment.edited", "comment.deleted"]);
    expect(JSON.stringify(createAuditLog.mock.calls)).not.toContain("secret words");
  });

  it("Instagram: hide/unhide/delete after proving the comment is on the target's media", async () => {
    const { caller } = buildCaller({});
    await caller.moderate({ targetId: TARGET_ID, commentId: "17900000000000001", action: "hide" });
    await caller.moderate({ targetId: TARGET_ID, commentId: "17900000000000001", action: "delete" });
    expect(getCommentMediaId).toHaveBeenCalledTimes(2);
    expect(igSetHidden).toHaveBeenCalledWith(expect.anything(), "17900000000000001", true);
    expect(igDelete).toHaveBeenCalledWith(expect.anything(), "17900000000000001");
  });

  it("Instagram: refuses a comment on other media, and refuses like/edit (not available there)", async () => {
    getCommentMediaId.mockResolvedValue("OTHER");
    const { caller } = buildCaller({});
    await expect(caller.moderate({ targetId: TARGET_ID, commentId: "17900000000000001", action: "delete" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(igDelete).not.toHaveBeenCalled();
    for (const action of ["like", "unlike"] as const) {
      await expect(caller.moderate({ targetId: TARGET_ID, commentId: "17900000000000001", action })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    await expect(
      caller.moderate({ targetId: TARGET_ID, commentId: "17900000000000001", action: "edit", message: "x" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("doesn't allow editing") });
  });

  it("validates input: edit needs text, and the comment id must be a Graph id", async () => {
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    await expect(caller.moderate({ targetId: TARGET_ID, commentId: "9_1", action: "edit" })).rejects.toThrow();
    await expect(caller.moderate({ targetId: TARGET_ID, commentId: "9_1/feed", action: "delete" })).rejects.toThrow();
    expect(fbEdit).not.toHaveBeenCalled();
    expect(fbDelete).not.toHaveBeenCalled();
  });

  it("applies the same org gate as list/reply", async () => {
    const { caller } = buildCaller({ target: { ...FB_TARGET, orgId: "org-other" }, channel: FB_CHANNEL });
    await expect(caller.moderate({ targetId: TARGET_ID, commentId: "9_1", action: "delete" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(fbDelete).not.toHaveBeenCalled();
  });
});


describe("🔒 Facebook writes are scoped to comments ON THIS POST", () => {
  // Caught in review 2026-09-23: the id-shape check alone accepts a Page POST id,
  // so `delete`/`edit` could have deleted or rewritten any live Page post.
  it("refuses a Page POST id (it starts with the Page id) for every write", async () => {
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    for (const action of ["delete", "hide", "like"] as const) {
      await expect(caller.moderate({ targetId: TARGET_ID, commentId: `${FB_PAGE}_12345`, action })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(
      caller.moderate({ targetId: TARGET_ID, commentId: `${FB_PAGE}_12345`, action: "edit", message: "defaced" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.reply({ targetId: TARGET_ID, commentId: `${FB_PAGE}_12345`, message: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fbDelete).not.toHaveBeenCalled();
    expect(fbEdit).not.toHaveBeenCalled();
    expect(fbSetHidden).not.toHaveBeenCalled();
    expect(fbReplyToComment).not.toHaveBeenCalled();
  });

  it("refuses the target post itself and any BARE id (a photo/video/post node, never a comment)", async () => {
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    for (const commentId of [`${FB_PAGE}_9`, "1748002179986936"]) {
      await expect(caller.moderate({ targetId: TARGET_ID, commentId, action: "delete" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(fbDelete).not.toHaveBeenCalled();
  });

  it("refuses a comment that belongs to ANOTHER post of the same Page", async () => {
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    await expect(caller.moderate({ targetId: TARGET_ID, commentId: "777_1", action: "delete" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("doesn't belong to this post"),
    });
  });

  it("accepts a comment (or reply) on this post — replies share the post's prefix", async () => {
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    await caller.moderate({ targetId: TARGET_ID, commentId: "9_1452846363362337", action: "hide" });
    expect(fbSetHidden).toHaveBeenCalledTimes(1);
  });

  it("video post: accepts comments prefixed by the video id OR its feed-post id (resolved once if unknown)", async () => {
    const resolveVideoPostId = vi.fn(async () => `${FB_PAGE}_4242`);
    const social = await import("@postautomation/social");
    (social.getSocialProvider as any).mockImplementation((platform: string) =>
      platform === "FACEBOOK"
        ? { setCommentHidden: fbSetHidden, deleteComment: fbDelete, setCommentLiked: fbSetLiked, editComment: fbEdit, replyToComment: fbReplyToComment, getPostComments, resolveVideoPostId }
        : { getMediaComments, replyToComment: igReplyToComment, getCommentMediaId, setCommentHidden: igSetHidden, deleteComment: igDelete }
    );
    const { caller } = buildCaller({ target: { publishedId: "1748002179986936" }, channel: FB_CHANNEL });
    await caller.moderate({ targetId: TARGET_ID, commentId: "1748002179986936_5", action: "hide" }); // video-id prefix: no lookup
    expect(resolveVideoPostId).not.toHaveBeenCalled();
    await caller.moderate({ targetId: TARGET_ID, commentId: "4242_6", action: "hide" }); // post-id prefix: resolved
    expect(resolveVideoPostId).toHaveBeenCalledTimes(1);
    await expect(caller.moderate({ targetId: TARGET_ID, commentId: "999_7", action: "hide" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fbSetHidden).toHaveBeenCalledTimes(2);
  });
});

describe("recorded grants are re-read when stale", () => {
  it("re-reads a grant that says a write permission is missing once it is over an hour old", async () => {
    getMediaComments.mockResolvedValue(EMPTY_PAGE);
    fetchMetaTokenWindow.mockResolvedValue({ valid: true, scopes: ["instagram_basic", "instagram_manage_comments"] });
    const old = new Date(Date.now() - 2 * 3600e3).toISOString();
    const { caller, executeRaw } = buildCaller({
      channel: { metadata: { igUserId: "IG_USER", grantedScopes: ["instagram_basic"], grantedScopesCheckedAt: old } },
    });
    const res = await caller.list({ targetId: TARGET_ID });
    expect(fetchMetaTokenWindow).toHaveBeenCalledTimes(1);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(res.capabilities).toMatchObject({ canReply: true, namesHidden: false });
  });

  it("does not re-read a recent 'missing' answer (at most once an hour)", async () => {
    getMediaComments.mockResolvedValue(EMPTY_PAGE);
    const { caller } = buildCaller({
      channel: { metadata: { igUserId: "IG_USER", grantedScopes: ["instagram_basic"], grantedScopesCheckedAt: FRESH } },
    });
    await caller.list({ targetId: TARGET_ID });
    expect(fetchMetaTokenWindow).not.toHaveBeenCalled();
  });

  it("keeps the old answer if the re-read fails", async () => {
    getMediaComments.mockResolvedValue(EMPTY_PAGE);
    fetchMetaTokenWindow.mockResolvedValue(null);
    const old = new Date(Date.now() - 8 * 24 * 3600e3).toISOString();
    const { caller } = buildCaller({
      channel: { metadata: { igUserId: "IG_USER", grantedScopes: ["instagram_basic", "instagram_manage_comments"], grantedScopesCheckedAt: old } },
    });
    const res = await caller.list({ targetId: TARGET_ID });
    expect(res.capabilities).toMatchObject({ known: true, canReply: true });
  });
});

describe("unconfirmed moderation is still audited", () => {
  it("records an unconfirmed delete with outcome 'unconfirmed'", async () => {
    fbDelete.mockRejectedValueOnce(new Error("The platform didn't confirm that change. Refresh the comments to see the current state."));
    const { caller } = buildCaller({ target: FB_TARGET, channel: FB_CHANNEL });
    await expect(caller.moderate({ targetId: TARGET_ID, commentId: "9_1", action: "delete" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(createAuditLog.mock.calls[0]![0]).toMatchObject({ action: "comment.deleted", metadata: { outcome: "unconfirmed" } });
  });
});
