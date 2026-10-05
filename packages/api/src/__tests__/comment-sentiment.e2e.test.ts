import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma as sharedPrisma } from "@postautomation/db";
import { createCallerFactory } from "../trpc";
import { commentRouter } from "../routers/comment.router";

/**
 * REAL-POSTGRES coverage for comment sentiment (2026-10-05). The daily series
 * is raw SQL and the totals are Prisma groupBy over a nullable enum with an OR
 * window — a mocked Prisma proves nothing about either. This runs the actual
 * queries against seeded rows, including another workspace's rows that must
 * never be counted.
 *
 * Skipped unless LIVE_E2E=1:
 *   DATABASE_URL=... TOKEN_ENCRYPTION_KEY=... LIVE_E2E=1 npx vitest run comment-sentiment.e2e
 */
const LIVE = process.env.LIVE_E2E === "1" && !!process.env.DATABASE_URL;
const d = LIVE ? describe : describe.skip;
const prisma: any = sharedPrisma;

const SUF = `csent-${Date.now()}`;
const ids = { user: "", org: "", other: "", ch1: "", ch2: "", otherCh: "", target: "", otherTarget: "" };
const DAY = 24 * 60 * 60 * 1000;

d("comment sentiment queries (real Postgres)", () => {
  beforeAll(async () => {
    const user = await prisma.user.create({ data: { email: `${SUF}@test.local`, name: "csent", isSuperAdmin: true } });
    ids.user = user.id;
    const org = await prisma.organization.create({ data: { name: `${SUF} org`, slug: `${SUF}-a` } });
    const other = await prisma.organization.create({ data: { name: `${SUF} other`, slug: `${SUF}-b` } });
    ids.org = org.id;
    ids.other = other.id;
    await prisma.organizationMember.create({ data: { organizationId: org.id, userId: user.id, role: "OWNER" } });
    const mk = (orgId: string, platform: string, name: string) =>
      prisma.channel.create({ data: { organizationId: orgId, platform, platformId: `${name}-${SUF}`, name, accessToken: "tok", scopes: [] } });
    ids.ch1 = (await mk(org.id, "INSTAGRAM", "insta")).id;
    ids.ch2 = (await mk(org.id, "FACEBOOK", "page")).id;
    ids.otherCh = (await mk(other.id, "INSTAGRAM", "foreign")).id;
    const post = await prisma.post.create({ data: { organizationId: org.id, createdById: user.id, content: "Trailer drop tonight!", status: "PUBLISHED" } });
    const otherPost = await prisma.post.create({ data: { organizationId: other.id, createdById: user.id, content: "x", status: "PUBLISHED" } });
    ids.target = (await prisma.postTarget.create({ data: { postId: post.id, channelId: ids.ch1, status: "PUBLISHED", publishedId: "M1" } })).id;
    ids.otherTarget = (await prisma.postTarget.create({ data: { postId: otherPost.id, channelId: ids.otherCh, status: "PUBLISHED", publishedId: "M2" } })).id;

    const now = Date.now();
    const row = (n: number, over: Record<string, unknown>) => ({
      organizationId: org.id,
      postTargetId: ids.target,
      channelId: ids.ch1,
      platform: "INSTAGRAM",
      commentId: `${SUF}-c${n}`,
      commentText: `comment ${n}`,
      commentedAt: new Date(now - DAY),
      ...over,
    });
    await prisma.commentSentiment.createMany({
      data: [
        row(1, { sentiment: "POSITIVE", sentimentScore: 0.9 }),
        row(2, { sentiment: "POSITIVE", sentimentScore: 0.5 }),
        row(3, { sentiment: "NEGATIVE", sentimentScore: -0.8 }),
        row(4, {}), // pending
        row(5, { commentedAt: null, sentiment: "NEUTRAL", sentimentScore: 0 }), // window falls back to createdAt
        row(6, { commentedAt: new Date(now - 60 * DAY), sentiment: "NEGATIVE", sentimentScore: -1 }), // outside 30 days
        row(7, { channelId: ids.ch2, platform: "FACEBOOK", sentiment: "NEGATIVE", sentimentScore: -0.6 }),
        // Another workspace's rows — must never be counted.
        { ...row(8, { sentiment: "NEGATIVE", sentimentScore: -1 }), organizationId: other.id, channelId: ids.otherCh, postTargetId: ids.otherTarget },
      ],
    });
    // A duplicate insert is ignored, as the sweep relies on.
    const dup = await prisma.commentSentiment.createMany({ data: [row(1, {})], skipDuplicates: true });
    expect(dup.count).toBe(0);
  });

  afterAll(async () => {
    if (!ids.org) return;
    await prisma.commentSentiment.deleteMany({ where: { organizationId: { in: [ids.org, ids.other] } } });
    await prisma.postTarget.deleteMany({ where: { id: { in: [ids.target, ids.otherTarget] } } });
    await prisma.post.deleteMany({ where: { organizationId: { in: [ids.org, ids.other] } } });
    await prisma.channel.deleteMany({ where: { organizationId: { in: [ids.org, ids.other] } } });
    await prisma.organizationMember.deleteMany({ where: { organizationId: ids.org } });
    await prisma.organization.deleteMany({ where: { id: { in: [ids.org, ids.other] } } });
    await prisma.user.deleteMany({ where: { id: ids.user } });
    await prisma.$disconnect();
  });

  const caller = () =>
    createCallerFactory(commentRouter)({
      prisma,
      session: { user: { id: ids.user, email: `${SUF}@test.local`, isSuperAdmin: true } } as any,
      organizationId: ids.org,
    });

  it("overview: totals, pending apart, window, org scope, by account, daily, worst posts", async () => {
    const out = await caller().sentimentOverview({ days: 30 });
    expect(out.totals).toEqual({ positive: 2, negative: 2, neutral: 1, mixed: 0, pending: 1, scored: 5, total: 6 });
    expect(out.avgScore).toBeCloseTo((0.9 + 0.5 - 0.8 + 0 - 0.6) / 5, 5);
    expect(out.byChannel.map((c) => [c.name, c.positive, c.negative, c.neutral, c.pending])).toEqual([
      ["insta", 2, 1, 1, 1],
      ["page", 0, 1, 0, 0],
    ]);
    const dayTotal = out.daily.reduce((t, d) => t + d.positive + d.negative + d.neutral + d.mixed + d.pending, 0);
    expect(dayTotal).toBe(6);
    // Comments 3 and 7 are both on this post (7 via the Page channel); 6 is outside the window.
    expect(out.worstPosts[0]).toMatchObject({ targetId: ids.target, negative: 2, caption: "Trailer drop tonight!" });
  });

  it("overview narrowed to one account", async () => {
    const out = await caller().sentimentOverview({ days: 30, channelId: ids.ch2 });
    expect(out.totals.total).toBe(1);
    expect(out.daily.reduce((t, d) => t + d.negative, 0)).toBe(1);
  });

  it("list: filters and never returns another workspace's comments", async () => {
    const neg = await caller().sentimentComments({ days: 30, sentiment: "NEGATIVE" });
    expect(neg.items.map((i: any) => i.commentText).sort()).toEqual(["comment 3", "comment 7"]);
    const pending = await caller().sentimentComments({ days: 30, sentiment: "PENDING" });
    expect(pending.items.map((i: any) => i.commentText)).toEqual(["comment 4"]);
    const all = await caller().sentimentComments({ days: 90, limit: 50 });
    expect(all.items).toHaveLength(7);
    expect(all.items.every((i: any) => i.channelName)).toBe(true);
  });
});
