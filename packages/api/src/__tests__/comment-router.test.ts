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
const getPostComments = vi.fn();
const fbReplyToComment = vi.fn();
const createAuditLog = vi.fn(async (_input: any) => {});

vi.mock("@postautomation/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@postautomation/social")>();
  return {
    ...actual,
    getSocialProvider: vi.fn((platform: string) =>
      platform === "FACEBOOK"
        ? { getPostComments, replyToComment: fbReplyToComment }
        : { getMediaComments, replyToComment: igReplyToComment }
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
  const prisma = {
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
  };
}

const FB_CHANNEL = {
  platform: "FACEBOOK",
  platformId: "PAGE_1",
  name: "Contents of bollywood",
  username: null,
  metadata: { pageId: "PAGE_1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  getMediaComments.mockReset();
  igReplyToComment.mockReset();
  getPostComments.mockReset();
  fbReplyToComment.mockReset();
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
    const { caller } = buildCaller({
      target: { publishedId: "PAGE_1_9" },
      channel: FB_CHANNEL,
    });
    const res = await caller.list({ targetId: TARGET_ID });
    expect(getPostComments).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "DECRYPTED_TOKEN" }),
      "PAGE_1_9",
      "PAGE_1",
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
    const { caller } = buildCaller({ channel: FB_CHANNEL });
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
    fbReplyToComment.mockResolvedValue({ id: "PAGE_1_77" });
    const { caller } = buildCaller({ target: { publishedId: "PAGE_1_9" }, channel: FB_CHANNEL });
    const res = await caller.reply({ targetId: TARGET_ID, commentId: "9_55", message: "Thank you!" });
    expect(res).toEqual({ id: "PAGE_1_77", platform: "FACEBOOK" });
    expect(fbReplyToComment).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "DECRYPTED_TOKEN" }),
      "9_55",
      "Thank you!",
      "PAGE_1"
    );
    expect(igReplyToComment).not.toHaveBeenCalled();
  });

  it("audit-logs a successful reply with who/where — never the reply text", async () => {
    fbReplyToComment.mockResolvedValue({ id: "PAGE_1_77" });
    const { caller } = buildCaller({ target: { publishedId: "PAGE_1_9" }, channel: FB_CHANNEL });
    await caller.reply({ targetId: TARGET_ID, commentId: "9_55", message: "a private-ish message" });

    expect(createAuditLog).toHaveBeenCalledTimes(1);
    const entry = createAuditLog.mock.calls[0]![0];
    expect(entry).toMatchObject({
      organizationId: ORG_ID,
      userId: USER_ID,
      action: "comment.replied",
      entityType: "PostTarget",
      entityId: TARGET_ID,
      metadata: { platform: "FACEBOOK", channelId: CHANNEL_ID, commentId: "9_55", replyId: "PAGE_1_77" },
    });
    expect(JSON.stringify(entry)).not.toContain("private-ish");
  });

  it("does NOT audit a reply the provider failed (or could not confirm)", async () => {
    fbReplyToComment.mockRejectedValue(new Error("Facebook accepted the reply but did not confirm it. … may already be posted."));
    const { caller } = buildCaller({ channel: FB_CHANNEL });
    await expect(caller.reply({ targetId: TARGET_ID, commentId: "9_55", message: "hi" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("may already be posted"),
    });
    expect(createAuditLog).not.toHaveBeenCalled();
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
    const fb = buildCaller({ channel: FB_CHANNEL });
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
    const gone = buildCaller({ channel: { ...FB_CHANNEL, disconnectedAt: new Date() } });
    await expect(gone.caller.reply({ targetId: TARGET_ID, commentId: "9_55", message: "hi" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(igReplyToComment).not.toHaveBeenCalled();
    expect(fbReplyToComment).not.toHaveBeenCalled();
  });
});

describe("comment.reply — commentId is the only client value reaching a Graph URL path", () => {
  it("🔴 REJECTS the arbitrary-authenticated-POST payload before any Graph call", async () => {
    const { caller } = buildCaller({ channel: FB_CHANNEL });
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
    const { caller } = buildCaller({ channel: FB_CHANNEL });
    await caller.reply({ targetId: TARGET_ID, commentId: "122111714397390760_9988776655", message: "hi" });
    expect(fbReplyToComment).toHaveBeenCalledWith(expect.anything(), "122111714397390760_9988776655", "hi", "PAGE_1");
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
