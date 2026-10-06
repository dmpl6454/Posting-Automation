/**
 * Comment sentiment on our own posts (2026-10-05) — the real commentRouter
 * through a tRPC caller with a mocked prisma: org scoping on every query,
 * pending kept apart from neutral, settings that an older client can't
 * switch off by omission, and the thread's per-comment annotation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createAuditLog = vi.fn(async (_input: any) => {});
vi.mock("../lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/audit")>();
  return { ...actual, createAuditLog: (input: any) => createAuditLog(input) };
});

import { createCallerFactory } from "../trpc";
import { commentRouter, youtubeCommentUrl } from "../routers/comment.router";

const ORG = "org-1";
const USER = "user-1";

function build(
  over: {
    role?: string;
    automation?: any;
    groupBy?: (a: any) => any[];
    findMany?: (a: any) => any[];
    queryRaw?: any[];
    channels?: (a: any) => any[];
    postTargets?: (a: any) => any[];
  } = {}
) {
  const groupBy = vi.fn(async (a: any) => (over.groupBy ? over.groupBy(a) : []));
  const sentimentFindMany = vi.fn(async (a: any) => (over.findMany ? over.findMany(a) : []));
  const queryRaw = vi.fn(async (..._a: any[]) => over.queryRaw ?? []);
  const upsert = vi.fn(async (_a: any) => ({}));
  const prisma = {
    $queryRaw: queryRaw,
    organizationMember: { findUnique: vi.fn(async () => ({ userId: USER, organizationId: ORG, role: over.role ?? "OWNER" })) },
    commentAutomation: {
      findUnique: vi.fn(async () => over.automation ?? null),
      upsert,
    },
    commentSentiment: {
      groupBy,
      aggregate: vi.fn(async () => ({ _avg: { sentimentScore: 0.25 } })),
      findMany: sentimentFindMany,
    },
    channel: {
      findMany: vi.fn(async (a: any) =>
        over.channels
          ? over.channels(a)
          : (a.where.id?.in ?? []).map((id: string) => ({ id, name: `Name ${id}`, platform: "INSTAGRAM", avatar: null }))
      ),
    },
    postTarget: {
      findMany: vi.fn(async (a: any) =>
        over.postTargets
          ? over.postTargets(a)
          : (a.where.id?.in ?? []).map((id: string) => ({ id, channelId: "ch-1", publishedUrl: null, publishedAt: null, post: { content: "Trailer drop!" } }))
      ),
    },
  } as any;
  const caller = createCallerFactory(commentRouter)({
    prisma,
    session: { user: { id: USER, email: "u@x", isSuperAdmin: true } } as any,
    organizationId: ORG,
  });
  return { caller, prisma, groupBy, sentimentFindMany, queryRaw, upsert };
}

beforeEach(() => vi.clearAllMocks());

describe("comment.sentimentOverview", () => {
  it("is org-scoped, keeps pending separate from neutral, and splits by account", async () => {
    const { caller, groupBy, queryRaw } = build({
      automation: { sentimentEnabled: true, lastRunAt: null, channelIds: [] },
      groupBy: (a) => {
        if (a.by.length === 1 && a.by[0] === "sentiment") {
          return [
            { sentiment: "POSITIVE", _count: { _all: 6 } },
            { sentiment: "NEGATIVE", _count: { _all: 3 } },
            { sentiment: "NEUTRAL", _count: { _all: 1 } },
            { sentiment: null, _count: { _all: 4 } },
          ];
        }
        if (a.by.includes("channelId")) {
          return [
            { channelId: "ch-1", sentiment: "POSITIVE", _count: { _all: 6 } },
            { channelId: "ch-1", sentiment: null, _count: { _all: 4 } },
            { channelId: "ch-2", sentiment: "NEGATIVE", _count: { _all: 3 } },
          ];
        }
        return [{ postTargetId: "t-9", _count: { _all: 3 } }];
      },
      queryRaw: [
        { day: "2026-10-04", sentiment: "POSITIVE", count: 2 },
        { day: "2026-10-04", sentiment: null, count: 1 },
        { day: "2026-10-05", sentiment: "NEGATIVE", count: 3 },
      ],
    });
    const out = await caller.sentimentOverview({ days: 7 });

    for (const call of groupBy.mock.calls) expect(call[0].where.organizationId).toBe(ORG);
    expect(out.totals).toEqual({ positive: 6, negative: 3, neutral: 1, mixed: 0, pending: 4, scored: 10, total: 14 });
    expect(out.avgScore).toBe(0.25);
    expect(out.enabled).toBe(true);
    expect(out.byChannel.map((c) => [c.channelId, c.positive, c.negative, c.pending])).toEqual([
      ["ch-1", 6, 0, 4],
      ["ch-2", 0, 3, 0],
    ]);
    expect(out.worstPosts).toEqual([
      expect.objectContaining({ targetId: "t-9", negative: 3, caption: "Trailer drop!", channelName: "Name ch-1" }),
    ]);
    expect(out.daily).toEqual([
      { day: "2026-10-04", positive: 2, negative: 0, neutral: 0, mixed: 0, pending: 1 },
      { day: "2026-10-05", positive: 0, negative: 3, neutral: 0, mixed: 0, pending: 0 },
    ]);
    // The daily series is scoped to the org by a bound parameter, not string interpolation.
    const sql = queryRaw.mock.calls[0]![0];
    expect(sql.values).toContain(ORG);
    expect(sql.strings.join("?")).toMatch(/"organizationId" = \?/);
  });

  it("no data and switched off", async () => {
    const { caller } = build();
    const out = await caller.sentimentOverview({});
    expect(out).toMatchObject({ enabled: false, avgScore: null, totals: { total: 0 }, daily: [], byChannel: [], worstPosts: [] });
  });

  it("an account filter narrows every query", async () => {
    const { caller, groupBy, queryRaw } = build();
    await caller.sentimentOverview({ channelId: "ch-2" });
    for (const call of groupBy.mock.calls) expect(call[0].where.channelId).toBe("ch-2");
    expect(queryRaw.mock.calls[0]![0].values).toContain("ch-2");
  });
});

describe("comment.sentimentComments", () => {
  it("filters by sentiment (or PENDING = unscored), org-scoped, with a cursor", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `s${i}`, channelId: "ch-1", commentText: "bad", sentiment: "NEGATIVE" }));
    const { caller, sentimentFindMany } = build({ findMany: () => rows });
    const out = await caller.sentimentComments({ sentiment: "NEGATIVE", limit: 2 });
    const where = sentimentFindMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ organizationId: ORG, sentiment: "NEGATIVE" });
    expect(out.items).toHaveLength(2);
    expect(out.nextCursor).toBe("s1");
    expect(out.items[0]).toMatchObject({ channelName: "Name ch-1" });

    await caller.sentimentComments({ sentiment: "PENDING" });
    expect(sentimentFindMany.mock.calls[1]![0].where.sentiment).toBeNull();
  });
});

describe("comment.updateAutomation sentiment switch", () => {
  const base = { autoHideEnabled: false, blockedWords: [], hideLinks: false, alertsEnabled: false, channelIds: [] };

  it("turns sentiment on", async () => {
    const { caller, upsert } = build();
    await caller.updateAutomation({ ...base, sentimentEnabled: true });
    expect(upsert.mock.calls[0]![0].update).toMatchObject({ sentimentEnabled: true });
    expect(upsert.mock.calls[0]![0].create).toMatchObject({ sentimentEnabled: true });
  });

  it("an older client that doesn't send the field leaves it untouched", async () => {
    const { caller, upsert } = build();
    await caller.updateAutomation(base);
    expect("sentimentEnabled" in upsert.mock.calls[0]![0].update).toBe(false);
  });

  it("members can't change it", async () => {
    const { caller } = build({ role: "MEMBER" });
    await expect(caller.updateAutomation({ ...base, sentimentEnabled: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("settings report the switch", async () => {
    const { caller } = build({ automation: { sentimentEnabled: true, blockedWords: [], channelIds: [] } });
    const out = await caller.automationSettings();
    expect(out.settings.sentimentEnabled).toBe(true);
  });
});

describe("YouTube comment sentiment (2026-10-06)", () => {
  it("youtubeCommentUrl only builds a URL from a real video id", () => {
    expect(youtubeCommentUrl("dQw4w9WgXcQ", "Ugx1.Ugy2")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&lc=Ugx1.Ugy2");
    expect(youtubeCommentUrl("dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(youtubeCommentUrl("Ugkx_community_post", "c")).toBeNull();
    expect(youtubeCommentUrl(null, "c")).toBeNull();
  });

  it("YouTube comments carry a link to the comment on YouTube, looked up org-scoped; others don't", async () => {
    const rows = [
      { id: "s1", channelId: "ch-yt", postTargetId: "t-yt", platform: "YOUTUBE", commentId: "Ugx1", commentText: "great" },
      { id: "s2", channelId: "ch-ig", postTargetId: "t-ig", platform: "INSTAGRAM", commentId: "179", commentText: "nice" },
    ];
    const { caller, prisma } = build({
      findMany: () => rows,
      postTargets: (a) => (a.where.id.in as string[]).map((id) => ({ id, publishedId: "dQw4w9WgXcQ" })),
    });
    const out = await caller.sentimentComments({});
    const ptWhere = prisma.postTarget.findMany.mock.calls[0]![0].where;
    expect(ptWhere).toEqual({ id: { in: ["t-yt"] }, post: { organizationId: ORG } });
    expect(out.items.map((i: any) => i.externalUrl)).toEqual(["https://www.youtube.com/watch?v=dQw4w9WgXcQ&lc=Ugx1", null]);
  });

  it("a YouTube post drawing negative comments links to the video", async () => {
    const { caller } = build({
      automation: { sentimentEnabled: true, lastRunAt: null, channelIds: [] },
      groupBy: (a) =>
        a.by.includes("postTargetId")
          ? [{ postTargetId: "t-yt", _count: { _all: 2 } }]
          : a.by.includes("channelId")
            ? [{ channelId: "ch-yt", sentiment: "NEGATIVE", _count: { _all: 2 } }]
            : [],
      channels: () => [{ id: "ch-yt", name: "Our Channel", platform: "YOUTUBE", avatar: null }],
      postTargets: () => [
        { id: "t-yt", channelId: "ch-yt", publishedId: "dQw4w9WgXcQ", publishedUrl: null, publishedAt: null, post: { content: "Trailer" } },
      ],
    });
    const out = await caller.sentimentOverview({ days: 30 });
    expect(out.worstPosts[0]).toMatchObject({ platform: "YOUTUBE", externalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(out.byChannel[0]).toMatchObject({ platform: "YOUTUBE", negative: 2 });
  });

  it("settings list YouTube channels as sentiment-only, never asking the Meta grant about them", async () => {
    const { caller, prisma } = build({
      channels: () => [
        { id: "ch-yt", platform: "YOUTUBE", name: "Our Channel", username: null, avatar: null, isActive: true, metadata: null },
        { id: "ch-fb", platform: "FACEBOOK", name: "Page", username: null, avatar: null, isActive: true, metadata: { grantedScopes: [] } },
      ],
    });
    const out = await caller.automationSettings();
    expect(prisma.channel.findMany.mock.calls[0]![0].where.platform).toEqual({ in: ["FACEBOOK", "INSTAGRAM", "YOUTUBE"] });
    expect(out.accounts).toEqual([
      expect.objectContaining({ id: "ch-yt", canModerate: null, sentimentOnly: true }),
      expect.objectContaining({ id: "ch-fb", canModerate: false, sentimentOnly: false }),
    ]);
  });
});
