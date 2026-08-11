import { describe, it, expect, beforeAll, afterAll } from "vitest";
// Import the workspace client, not @prisma/client directly — under pnpm's
// isolated layout @prisma/client is only reachable via packages/db/node_modules.
import { prisma } from "@postautomation/db";
import { appRouter } from "../root";

/**
 * REAL-POSTGRES verification of the Insights availability plumbing.
 *
 * Unit tests cannot cover this: the per-metric availability aggregate is raw SQL
 * that digs into the `AnalyticsSnapshot.metadata` jsonb column
 * (`s.metadata->'metricsAvailable'->>'impressions'`). A mocked Prisma would
 * happily "pass" while the real jsonb expression was wrong, so this runs the
 * actual query against a real database.
 *
 * Skipped by default (repo convention for *.e2e.test.ts — these need infra).
 * Run with:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postautomation \
 *   LIVE_E2E=1 npx vitest run insights-availability-sql
 */
const LIVE = process.env.LIVE_E2E === "1" && !!process.env.DATABASE_URL;

const SUFFIX = "insights-avail-e2e";

let orgId: string;
let userId: string;
const ids: { fbVideo?: string; fbFeed?: string; ig?: string; legacy?: string } = {};

async function seed() {
  const user = await prisma.user.create({
    data: { email: `${SUFFIX}-${Date.now()}@example.test`, name: "E2E" },
  });
  userId = user.id;
  const org = await prisma.organization.create({
    data: {
      name: `${SUFFIX}-org`,
      slug: `${SUFFIX}-${Date.now()}`,
      members: { create: { userId, role: "OWNER" } },
    },
  });
  orgId = org.id;

  /** Creates channel + post + published target + one snapshot with given metadata. */
  async function mk(
    name: string,
    platform: any,
    metrics: { impressions: number; reach: number; likes: number; comments: number; shares: number; clicks: number },
    metadata: any | undefined
  ) {
    const channel = await prisma.channel.create({
      data: {
        organizationId: orgId,
        platform,
        name,
        platformId: `${name}-${Date.now()}`,
        accessToken: "tok",
        isActive: true,
        ...(metadata?.__channelMeta ? { metadata: metadata.__channelMeta } : {}),
      },
    });
    const post = await prisma.post.create({
      data: {
        organizationId: orgId,
        content: `${name} content`,
        status: "PUBLISHED",
        publishedAt: new Date(),
        createdById: userId,
      },
    });
    const target = await prisma.postTarget.create({
      data: {
        postId: post.id,
        channelId: channel.id,
        status: "PUBLISHED",
        publishedAt: new Date(),
        publishedId: `${name}-pid`,
      },
    });
    await prisma.analyticsSnapshot.create({
      data: {
        postTargetId: target.id,
        platform,
        ...metrics,
        engagementRate: 0,
        snapshotAt: new Date(),
        ...(metadata && !metadata.__channelMeta ? { metadata } : {}),
        ...(metadata?.snapshotMeta ? { metadata: metadata.snapshotMeta } : {}),
      },
    });
    return channel.id;
  }

  // A FB VIDEO post: video_insights delivered real views → impressions AVAILABLE.
  // This is the case the static platform map alone would wrongly hide as "—".
  ids.fbVideo = await mk(
    "fb-video",
    "FACEBOOK",
    { impressions: 5000, reach: 0, likes: 7, comments: 2, shares: 0, clicks: 0 },
    { metricsAvailable: { impressions: true, reach: false, clicks: false, shares: false }, source: "api" }
  );

  // A FB FEED post: Meta deleted the impressions metric → UNAVAILABLE.
  ids.fbFeed = await mk(
    "fb-feed",
    "FACEBOOK",
    { impressions: 0, reach: 0, likes: 3, comments: 1, shares: 1, clicks: 4 },
    { metricsAvailable: { impressions: false, reach: false, clicks: true, comments: true, likes: true } }
  );

  // An IG post with a real `saved` count, and a needs_reconnect channel verdict.
  ids.ig = await mk(
    "ig-reel",
    "INSTAGRAM",
    { impressions: 115, reach: 106, likes: 0, comments: 0, shares: 0, clicks: 0 },
    {
      snapshotMeta: {
        metricsAvailable: { impressions: true, reach: true, shares: true, clicks: false },
        saved: 1,
        avgWatchTimeMs: 3038,
      },
    }
  );

  // A LEGACY snapshot with NO metadata at all → must fall back to the static map.
  ids.legacy = await mk(
    "fb-legacy",
    "FACEBOOK",
    { impressions: 99, reach: 88, likes: 1, comments: 1, shares: 1, clicks: 1 },
    undefined
  );

  // Mark one channel as needing a reconnect (what the sync worker writes).
  await prisma.channel.update({
    where: { id: ids.fbFeed! },
    data: {
      metadata: {
        insightsHealth: {
          status: "needs_reconnect",
          reason: "missing_scope",
          missingScopes: ["read_insights", "pages_read_user_content"],
          detail: "Reconnect to grant: pages_read_user_content, read_insights.",
          checkedAt: new Date().toISOString(),
        },
      },
    },
  });
}

async function cleanup() {
  if (!orgId) return;
  const posts = await prisma.post.findMany({ where: { organizationId: orgId }, select: { id: true } });
  const targets = await prisma.postTarget.findMany({
    where: { postId: { in: posts.map((p) => p.id) } },
    select: { id: true },
  });
  await prisma.analyticsSnapshot.deleteMany({ where: { postTargetId: { in: targets.map((t) => t.id) } } });
  await prisma.postTarget.deleteMany({ where: { postId: { in: posts.map((p) => p.id) } } });
  await prisma.post.deleteMany({ where: { organizationId: orgId } });
  await prisma.channel.deleteMany({ where: { organizationId: orgId } });
  await prisma.organizationMember.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.user.delete({ where: { id: userId } });
}

function caller() {
  return appRouter.createCaller({
    prisma,
    session: {
      user: { id: userId, email: "e2e@example.test", isSuperAdmin: false, appRole: "ADMIN" },
    },
    organizationId: orgId,
    membership: { role: "OWNER" },
    isSuperAdmin: false,
    headers: new Headers(),
  } as any);
}

describe.skipIf(!LIVE)("Insights availability — real Postgres", () => {
  beforeAll(async () => {
    await seed();
  }, 60_000);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  }, 60_000);

  it("perChannelStats: a FB VIDEO capture REVEALS impressions the static map would hide", async () => {
    const rows = await caller().analytics.perChannelStats({});
    const video = rows.find((r: any) => r.name === "fb-video")!;
    expect(video).toBeTruthy();
    expect(video.impressions).toBe(5000);
    // The whole point of the jsonb aggregate: NOT in the unavailable list.
    expect(video.unavailable).not.toContain("impressions");
    expect(video.unavailable).toContain("reach");
  });

  it("perChannelStats: a FB FEED capture keeps impressions/reach unavailable", async () => {
    const rows = await caller().analytics.perChannelStats({});
    const feed = rows.find((r: any) => r.name === "fb-feed")!;
    expect(feed.unavailable).toContain("impressions");
    expect(feed.unavailable).toContain("reach");
    // clicks WERE reported (a real 4) so they must render, not show "—".
    expect(feed.unavailable).not.toContain("clicks");
    expect(feed.clicks).toBe(4);
  });

  it("perChannelStats: a LEGACY metadata-less capture falls back to the static map", async () => {
    const rows = await caller().analytics.perChannelStats({});
    const legacy = rows.find((r: any) => r.name === "fb-legacy")!;
    // FACEBOOK static caps mark impressions + reach unavailable.
    expect(legacy.unavailable).toContain("impressions");
    expect(legacy.unavailable).toContain("reach");
  });

  it("perChannelStats: IG reports impressions/reach and keeps clicks unavailable", async () => {
    const rows = await caller().analytics.perChannelStats({});
    const ig = rows.find((r: any) => r.name === "ig-reel")!;
    expect(ig.impressions).toBe(115);
    expect(ig.reach).toBe(106);
    expect(ig.unavailable).not.toContain("impressions");
    expect(ig.unavailable).not.toContain("reach");
    expect(ig.unavailable).toContain("clicks");
  });

  it("perChannelStats: surfaces the per-channel reconnect verdict", async () => {
    const rows = await caller().analytics.perChannelStats({});
    const feed = rows.find((r: any) => r.name === "fb-feed")!;
    expect(feed.insightsHealth?.status).toBe("needs_reconnect");
    expect(feed.insightsHealth?.missingScopes).toContain("read_insights");
    // A healthy channel now reports an explicit "ok" rather than null, because the
    // evaluator also has to carry the data-access deadline when there is one.
    const video = rows.find((r: any) => r.name === "fb-video")!;
    expect(video.insightsHealth?.status).toBe("ok");
  });

  it("insightsHealth: counts only explicitly-flagged channels", async () => {
    const h = await caller().analytics.insightsHealth();
    expect(h.needsReconnectCount).toBe(1);
    expect(h.channels[0]!.name).toBe("fb-feed");
    expect(h.missingScopes).toEqual(["pages_read_user_content", "read_insights"]);
    expect(h.totalActiveChannels).toBe(4);
  });

  it("postReports: projects `saved` out of the capture metadata", async () => {
    const res = await caller().analytics.postReports({ window: "24h", mode: "current", limit: 50 });
    const reel = res.rows.find((r: any) => r.channelName === "ig-reel")!;
    expect(reel).toBeTruthy();
    expect(reel.saved).toBe(1);
    expect(reel.avgWatchTimeMs).toBe(3038);
    expect(reel.impressions).toBe(115);

    // And the FB feed row must show "—" (null) for impressions, not 0.
    const feed = res.rows.find((r: any) => r.channelName === "fb-feed")!;
    expect(feed.impressions).toBeNull();
    expect(feed.clicks).toBe(4);
    expect(feed.saved).toBeNull();
  });

  it("postReports: nulls the engagement rate when impressions are unavailable", async () => {
    // Engagement rate is engagement ÷ impressions. With impressions rendering
    // "—", a printed rate is derived from a number we told the user we don't
    // have — and "0.00%" misreads as "no engagement" rather than "not reported".
    const res = await caller().analytics.postReports({ window: "24h", mode: "current", limit: 50 });
    const feed = res.rows.find((r: any) => r.channelName === "fb-feed")!;
    expect(feed.impressions).toBeNull();
    expect(feed.engagementRate).toBeNull();

    const legacy = res.rows.find((r: any) => r.channelName === "fb-legacy")!;
    expect(legacy.impressions).toBeNull(); // static-map fallback hides it
    expect(legacy.engagementRate).toBeNull(); // …so the rate must hide too

    // IG DOES report impressions, so its rate stays a real number.
    const reel = res.rows.find((r: any) => r.channelName === "ig-reel")!;
    expect(reel.impressions).toBe(115);
    expect(typeof reel.engagementRate).toBe("number");
  });

  it("groupStats: aggregates without dropping the ungrouped channels", async () => {
    const g = await caller().analytics.groupStats({});
    const ungrouped = g.rows.find((r: any) => r.id === "__ungrouped__");
    expect(ungrouped).toBeTruthy();
    // 5000 (video) + 0 (feed) + 115 (ig) + 99 (legacy)
    expect(ungrouped!.impressions).toBe(5214);
  });

  /**
   * The engagement-rate pooling and history-inclusion changes (2026-08-06) live
   * entirely in raw SQL (`FILTER (WHERE s.impressions > 0)` and the un-filtered
   * Channel join), which a mocked Prisma cannot exercise at all.
   */
  it("perChannelStats: engagement rate pools ONLY over impressioned posts", async () => {
    const rows = await caller().analytics.perChannelStats({});

    // fb-feed reported clicks/likes but NO impressions ⇒ no honest denominator.
    const feed = rows.find((r: any) => r.name === "fb-feed")!;
    expect(feed.engagementRateBasis.impressionedPosts).toBe(0);
    // ⚠️ Updated 2026-08-11 (was `toBe(0)`). This assertion had gone STALE and
    // nothing caught it, because this whole suite is `skipIf(!LIVE_E2E)` and so
    // never runs in a normal test pass — the exact rot the plan's P2-8 gap warned
    // about. Verified by running the suite at pre-change main (6482fa8): it fails
    // there identically, so this is not a regression.
    //
    // `pooledEngagementRate` returns `rate: null` + `reason: "no_basis"` for a
    // zero base (engagement-rate.ts:83). null is the CORRECT contract: a channel
    // with no impressioned posts has no rate, and 0 would be indistinguishable
    // from "measured zero engagement". The sibling test above
    // ("postReports: nulls the engagement rate…") already asserts null for the
    // same situation — this line was simply never updated alongside it.
    expect(feed.engagementRate).toBeNull(); // UI renders "—"; null, never a fake 0

    // fb-video DID report impressions (5000) with 7 likes + 2 comments.
    const video = rows.find((r: any) => r.name === "fb-video")!;
    expect(video.engagementRateBasis.impressionedPosts).toBe(1);
    expect(video.engagementRateBasis.totalPosts).toBe(1);
    expect(video.engagementRate).toBeCloseTo(((7 + 2) / 5000) * 100, 4);
  });

  it("perChannelStats: reports each channel's lifecycle status", async () => {
    const rows = await caller().analytics.perChannelStats({});
    expect(rows.find((r: any) => r.name === "fb-video")!.channelStatus).toBe("connected");
  });

  it("perChannelStats: a DISCONNECTED channel keeps its history (the whole point)", async () => {
    // Soft-delete the IG fixture exactly as channel.disconnect does.
    await prisma.channel.update({
      where: { id: ids.ig! },
      data: { disconnectedAt: new Date(), isActive: false, accessToken: "disconnected", refreshToken: null },
    });
    try {
      const rows = await caller().analytics.perChannelStats({});
      const reel = rows.find((r: any) => r.name === "ig-reel");
      // Before soft-delete existed, a hard delete removed the row AND its
      // PostTargets; and the isActive-filtered aggregate hid it even when paused.
      expect(reel).toBeTruthy();
      expect(reel!.channelStatus).toBe("disconnected");
      expect(reel!.impressions).toBe(115);
      expect(reel!.reach).toBe(106);

      // …and it still contributes to the group/org aggregate.
      const g = await caller().analytics.groupStats({});
      const ungrouped = g.rows.find((r: any) => r.id === "__ungrouped__");
      expect(ungrouped!.impressions).toBe(5214);
    } finally {
      await prisma.channel.update({
        where: { id: ids.ig! },
        data: { disconnectedAt: null, isActive: true, accessToken: "tok" },
      });
    }
  });
});
