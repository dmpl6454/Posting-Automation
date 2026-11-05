import { describe, it, expect, vi } from "vitest";
import {
  buildStoryInsightRow,
  pickStorySnapshot,
  summarizeStoryInsights,
  type StorySnapshotInput,
  type StoryTargetInput,
} from "../lib/story-insights";

vi.mock("@postautomation/queue", () => ({
  insightsIncludeExternalPosts: () => false,
  externalPostFloor: () => new Date("2026-08-01T00:00:00.000Z"),
  externalPostFloorLabel: () => "1 Aug 2026",
  excludeUnmeasurableStoriesWhere: () => ({}),
  analyticsSyncQueue: { add: vi.fn() },
  externalPostSyncQueue: { add: vi.fn() },
}));

import { createCallerFactory } from "../trpc";
import { analyticsRouter } from "../routers/analytics.router";

/**
 * Story insights (2026-11-05). Each rule here is a lesson the Insights code has
 * already paid for once: "—" is not 0, a quiet story is not a broken channel, a
 * later failed capture must not bury real numbers, and a cap is not a count.
 */

const NOW = new Date("2026-11-05T12:00:00.000Z");
const PUBLISHED = new Date("2026-11-05T02:00:00.000Z"); // 10h ago → still live

const target = (o: Partial<StoryTargetInput> = {}): StoryTargetInput => ({
  targetId: "t1",
  postId: "p1",
  platform: "INSTAGRAM",
  channelId: "c1",
  channelName: "Bollywood",
  channelHandle: "bollywood",
  channelAvatar: null,
  publishedAt: PUBLISHED,
  url: "https://www.instagram.com/stories/bollywood/1/",
  note: "",
  thumbnailUrl: null,
  isVideo: false,
  ...o,
});

const snap = (o: Partial<StorySnapshotInput> = {}): StorySnapshotInput => ({
  views: 120,
  reach: 90,
  shares: 2,
  impressions: 120,
  snapshotAt: new Date("2026-11-05T08:00:00.000Z"),
  metadata: {
    metricsAvailable: { views: true, reach: true, shares: true, likes: false, comments: false },
    story: { replies: 3, exits: 10, tapsForward: 40, tapsBack: 5, swipeForward: 7, profileVisits: 4, follows: 1, linkClicks: 2 },
  },
  ...o,
});

describe("buildStoryInsightRow", () => {
  it("builds a measured, live Instagram row with every story metric", () => {
    const r = buildStoryInsightRow(target(), [snap()], NOW);
    expect(r.status).toBe("measured");
    expect(r.live).toBe(true);
    expect(r.expiresAt.toISOString()).toBe("2026-11-06T02:00:00.000Z");
    expect(r).toMatchObject({ views: 120, reach: 90, shares: 2, replies: 3, exits: 10, tapsForward: 40, tapsBack: 5, swipeForward: 7, profileVisits: 4, follows: 1, linkClicks: 2 });
    expect(r.final).toBe(false);
  });

  it("a metric the capture did not report is null, never 0", () => {
    // A snapshot taken before the story extras existed.
    const r = buildStoryInsightRow(target(), [snap({ metadata: { metricsAvailable: { views: true, reach: true, shares: false } } })], NOW);
    expect(r.shares).toBeNull();
    expect(r.replies).toBeNull();
    expect(r.exits).toBeNull();
    expect(r.views).toBe(120);
  });

  it("Facebook Page stories say 'not available' instead of showing zeros", () => {
    const r = buildStoryInsightRow(target({ platform: "FACEBOOK" }), [snap()], NOW);
    expect(r.status).toBe("not_available");
    expect(r.views).toBeNull();
  });

  it("no capture yet → pending", () => {
    expect(buildStoryInsightRow(target(), [], NOW).status).toBe("pending");
  });

  it("a story under 5 viewers is low_viewers, not reconnect", () => {
    const r = buildStoryInsightRow(
      target(),
      [snap({ views: null, reach: 0, metadata: { metricsAvailable: { views: false, reach: false, shares: false }, story: { notEnoughViewers: true } } })],
      NOW
    );
    expect(r.status).toBe("low_viewers");
  });

  it("only failed captures → reconnect", () => {
    const r = buildStoryInsightRow(target(), [snap({ metadata: { degraded: { reason: "token_invalid" } } })], NOW);
    expect(r.status).toBe("reconnect");
    expect(r.views).toBeNull();
  });

  it("a later failed capture never buries the clean one", () => {
    const clean = snap({ snapshotAt: new Date("2026-11-05T06:00:00Z") });
    const failed = snap({ views: 0, reach: 0, snapshotAt: new Date("2026-11-05T09:00:00Z"), metadata: { degraded: { reason: "token_invalid" } } });
    expect(pickStorySnapshot([failed, clean])).toBe(clean);
    expect(buildStoryInsightRow(target(), [failed, clean], NOW).views).toBe(120);
  });

  it("marks the end-of-life capture as final and an old story as expired", () => {
    const old = target({ publishedAt: new Date("2026-11-03T02:00:00Z") });
    const checkpoint = snap({ metadata: { windowTag: "24h", metricsAvailable: { views: true, reach: true, shares: true } } });
    const r = buildStoryInsightRow(old, [checkpoint], NOW);
    expect(r.live).toBe(false);
    expect(r.final).toBe(true);
  });
});

describe("summarizeStoryInsights", () => {
  it("sums only reported values; a metric nobody reported stays null", () => {
    const a = buildStoryInsightRow(target(), [snap()], NOW);
    const b = buildStoryInsightRow(target({ targetId: "t2", platform: "FACEBOOK" }), [], NOW);
    const c = buildStoryInsightRow(target({ targetId: "t3" }), [snap({ views: 30, reach: 20, metadata: { metricsAvailable: { views: true, reach: true, shares: true } } })], NOW);
    const t = summarizeStoryInsights([a, b, c]);
    expect(t).toMatchObject({ stories: 3, measured: 2, live: 3, views: 150, reachSummed: 110, replies: 3, exits: 10 });
    expect(summarizeStoryInsights([b]).views).toBeNull();
  });
});

describe("analytics.storyInsights", () => {
  function harness(targets: any[] = [], snapshots: any[] = [], total = targets.length) {
    const findMany = vi.fn(async (_a: any) => targets);
    const count = vi.fn(async (_a: any) => total);
    const snapFind = vi.fn(async (_a: any) => snapshots);
    const prisma: any = {
      organizationMember: { findUnique: vi.fn(async () => ({ userId: "u1", organizationId: "org-1", role: "OWNER" })) },
      organization: { findUnique: vi.fn(async () => ({ id: "org-1", plan: "FREE" })) },
      postTarget: { findMany, count },
      analyticsSnapshot: { findMany: snapFind },
    };
    const caller = createCallerFactory(analyticsRouter)({
      prisma,
      session: { user: { id: "u1", email: "u@example.com" } },
      organizationId: "org-1",
    } as any);
    return { caller, findMany, count, snapFind };
  }

  const dbTarget = (id: string, fileType = "image/jpeg") => ({
    id,
    postId: "p1",
    publishedAt: new Date(),
    publishedUrl: null,
    channel: { id: "c1", name: "Bollywood", username: "bw", avatar: null, platform: "INSTAGRAM" },
    post: { content: "note", mediaAttachments: [{ media: { url: "https://x/v.mp4", fileType, thumbnailUrl: null } }] },
  });

  it("scopes to the caller's org, STORY format and PUBLISHED targets", async () => {
    const { caller, findMany, count } = harness();
    await caller.storyInsights({ days: 7 });
    const where = findMany.mock.calls[0]![0].where;
    expect(where.post).toEqual({ organizationId: "org-1" });
    expect(where.format).toBe("STORY");
    expect(where.status).toBe("PUBLISHED");
    expect(count.mock.calls[0]![0].where).toEqual(where);
  });

  it("reports the true total beside a capped list", async () => {
    const { caller } = harness([dbTarget("t1")], [], 812);
    const res = await caller.storyInsights();
    expect(res.total).toBe(812);
    expect(res.truncated).toBe(true);
  });

  it("never offers a video file as a thumbnail", async () => {
    const { caller } = harness([dbTarget("t1", "video/mp4")]);
    const res = await caller.storyInsights();
    expect(res.rows[0]!.isVideo).toBe(true);
    expect(res.rows[0]!.thumbnailUrl).toBeNull();
  });

  it("skips the snapshot query when there are no stories", async () => {
    const { caller, snapFind } = harness();
    const res = await caller.storyInsights();
    expect(snapFind).not.toHaveBeenCalled();
    expect(res.rows).toEqual([]);
  });
});
