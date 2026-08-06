import { describe, it, expect } from "vitest";
import { computeEngagementRate } from "../lib/engagement-rate";
import { sumChannelRowsIntoGroups, type ChannelStatRow } from "../lib/group-stats";

describe("computeEngagementRate", () => {
  it("does not let a zero-impression target inflate the pooled rate", () => {
    // IG: 1000 impr, 20 eng (true 2%). LinkedIn member: 0 impr, 80 eng.
    // Old ratio-of-sums = (20+80)/(1000+0)*100 = 10%. Correct = 2%.
    const rows = [
      { impressions: 1000, likes: 20, comments: 0, shares: 0 },
      { impressions: 0, likes: 80, comments: 0, shares: 0 },
    ];
    expect(computeEngagementRate(rows)).toBeCloseTo(2.0, 6);
  });

  it("returns 0 when no impressions anywhere", () => {
    expect(computeEngagementRate([{ impressions: 0, likes: 5, comments: 3, shares: 1 }])).toBe(0);
  });

  it("returns 0 for an empty set", () => {
    expect(computeEngagementRate([])).toBe(0);
  });

  it("sums engagement types across impressioned rows", () => {
    const rows = [
      { impressions: 100, likes: 5, comments: 3, shares: 2 }, // 10/100
      { impressions: 100, likes: 10, comments: 0, shares: 0 }, // 10/100
    ];
    // (10 + 10) / (100 + 100) * 100 = 10%
    expect(computeEngagementRate(rows)).toBeCloseTo(10, 6);
  });
});

/**
 * ── The 1400% regression (2026-08-06) ────────────────────────────────────────
 * `perChannelStats` and `groupStats` never adopted the rule above: they computed
 * the rate from RAW channel sums, i.e. numerator over ALL posts but denominator
 * from only the impressioned ones. On Facebook only VIDEO posts carry an
 * impression figure, so a channel's whole reaction count got divided by one
 * video's view count. Reproduced from the exact prod numbers.
 */
function row(o: Partial<ChannelStatRow> & { channelId: string }): ChannelStatRow {
  return {
    posts: 0, impressions: 0, reach: 0, likes: 0, comments: 0, shares: 0, clicks: 0, ...o,
  } as ChannelStatRow;
}

describe("channel-level rate — real prod cases", () => {
  it("documents the OLD wrong answer so the regression is unmistakable", () => {
    // "Contents of bollywood": 14 reactions over 7 posts ÷ one 1-view video.
    expect((14 / 1) * 100).toBe(1400);
  });

  it("Contents of bollywood ⇒ 200% (2 reactions on the 1-view video), not 1400%", () => {
    const posts = [
      { impressions: 1, likes: 2, comments: 0, shares: 0 },
      ...Array.from({ length: 6 }, () => ({ impressions: 0, likes: 2, comments: 0, shares: 0 })),
    ];
    expect(computeEngagementRate(posts)).toBe(200);
  });

  it("Bollywood ⇒ 7.02%, not the plausible-looking 8.77%", () => {
    const posts = [
      { impressions: 57, likes: 4, comments: 0, shares: 0 },
      { impressions: 0, likes: 1, comments: 0, shares: 0 },
      ...Array.from({ length: 8 }, () => ({ impressions: 0, likes: 0, comments: 0, shares: 0 })),
    ];
    expect(computeEngagementRate(posts)).toBeCloseTo(7.018, 2);
  });
});

describe("group-level rate pools from the impressioned-only channel sums", () => {
  const groups = [{ id: "g1", name: "fb", color: "#fff", channels: [{ id: "c1" }, { id: "c2" }] }];

  it("fixes the 32.76% group inflation ⇒ 10.34%", () => {
    const rows = [
      row({ channelId: "c1", posts: 10, impressions: 57, likes: 5,
            impressionedImpressions: 57, impressionedLikes: 4, impressionedComments: 0,
            impressionedShares: 0, impressionedPosts: 1 }),
      row({ channelId: "c2", posts: 7, impressions: 1, likes: 14,
            impressionedImpressions: 1, impressionedLikes: 2, impressionedComments: 0,
            impressionedShares: 0, impressionedPosts: 1 }),
    ];
    const [fb] = sumChannelRowsIntoGroups(groups, rows, 0);
    // (4+2) / (57+1) * 100 = 10.34%, NOT (5+14)/58 = 32.76%
    expect(fb!.engagementRate).toBeCloseTo(10.34, 1);
    // Displayed SUMS are untouched — only the rate's basis changed.
    expect(fb!.impressions).toBe(58);
    expect(fb!.likes).toBe(19);
  });

  it("falls back to raw sums when impressioned fields are absent (older callers)", () => {
    const rows = [row({ channelId: "c1", posts: 2, impressions: 100, likes: 10 })];
    expect(sumChannelRowsIntoGroups(groups, rows, 0)[0]!.engagementRate).toBeCloseTo(10, 5);
  });

  it("is 0 — never Infinity or NaN — when nothing reported impressions", () => {
    const rows = [row({ channelId: "c1", posts: 3, impressions: 0, likes: 9,
                        impressionedImpressions: 0, impressionedLikes: 0, impressionedPosts: 0 })];
    const rate = sumChannelRowsIntoGroups(groups, rows, 0)[0]!.engagementRate;
    expect(rate).toBe(0);
    expect(Number.isFinite(rate)).toBe(true);
  });

  it("a zero-impression channel can't inflate a group containing an impressioned one", () => {
    const rows = [
      row({ channelId: "c1", posts: 1, impressions: 1000, likes: 20,
            impressionedImpressions: 1000, impressionedLikes: 20, impressionedPosts: 1 }),
      row({ channelId: "c2", posts: 1, impressions: 0, likes: 80,
            impressionedImpressions: 0, impressionedLikes: 0, impressionedPosts: 0 }),
    ];
    expect(sumChannelRowsIntoGroups(groups, rows, 0)[0]!.engagementRate).toBeCloseTo(2, 5);
  });
});
