import { describe, it, expect } from "vitest";
import {
  pooledEngagementRate,
  computeEngagementRate,
  MIN_CONFIDENT_RATE_IMPRESSIONS,
} from "../lib/engagement-rate";
import { sumChannelRowsIntoGroups } from "../lib/group-stats";

/**
 * The engagement-rate verdict rule.
 *
 * Prod 2026-08-08: Channel Performance rendered "Contents of bollywood" at
 * **200.00% (1/10)** — 2 interactions over a denominator of ONE impression. The
 * pooling rule from PR #160 was working correctly (both sides summed over the
 * same `FILTER (WHERE impressions > 0)` rows); what was missing is that a rate
 * above 100% is definitionally impossible and must never be printed.
 *
 * ⚠️ Suppressing merely-SMALL bases was considered and REJECTED: prod-verified
 * reel view counts are 54/452/17/7/75, so a floor of 100 would blank three of
 * five legitimate rates. A floor also cannot fix >100%, which is a population
 * mismatch (FB reactions from the insights edge vs. views from the reel
 * scraper) and is unbounded at any denominator. Hence: only the impossible tier
 * suppresses; a thin base is decorated, not hidden.
 */
describe("pooledEngagementRate", () => {
  it('returns null/"no_basis" when nothing reported an impression', () => {
    const v = pooledEngagementRate({ impressions: 0, interactions: 5, impressionedPosts: 0 });
    expect(v.rate).toBeNull();
    expect(v.reason).toBe("no_basis");
  });

  it('returns null/"no_basis" when posts exist but impressions total zero', () => {
    const v = pooledEngagementRate({ impressions: 0, interactions: 0, impressionedPosts: 3 });
    expect(v.rate).toBeNull();
    expect(v.reason).toBe("no_basis");
  });

  it('PROD REPRO: 2 interactions over 1 impression is null/"rate_impossible", not 200%', () => {
    // "Contents of bollywood", Channel Performance, 2026-08-08.
    const v = pooledEngagementRate({ impressions: 1, interactions: 2, impressionedPosts: 1 });
    expect(v.rate).toBeNull();
    expect(v.reason).toBe("rate_impossible");
  });

  it("PROD TRUTH: Bollywood 4 interactions / 57 impressions still renders ~7.02%", () => {
    const v = pooledEngagementRate({ impressions: 57, interactions: 4, impressionedPosts: 1 });
    expect(v.rate).toBeCloseTo(7.02, 1);
    expect(v.reason).toBeUndefined();
    expect(v.lowBase).toBe(false); // 57 >= 50
  });

  it("PROD TRUTH: the group row at denominator 58 still renders ~10.34%", () => {
    const v = pooledEngagementRate({ impressions: 58, interactions: 6, impressionedPosts: 2 });
    expect(v.rate).toBeCloseTo(10.34, 1);
    expect(v.lowBase).toBe(false);
  });

  it("a small REAL reel base is flagged lowBase but NEVER suppressed", () => {
    // A live-measured reel: 17 views. Blanking this would hide real data.
    const v = pooledEngagementRate({ impressions: 17, interactions: 2, impressionedPosts: 1 });
    expect(v.rate).toBeCloseTo(11.76, 1);
    expect(v.lowBase).toBe(true);
    expect(v.reason).toBeUndefined();
  });

  it("a genuine zero on a healthy base renders 0, not null", () => {
    const v = pooledEngagementRate({ impressions: 500, interactions: 0, impressionedPosts: 5 });
    expect(v.rate).toBe(0);
    expect(v.reason).toBeUndefined();
  });

  it("interactions EQUAL to impressions is 100% — the boundary is not impossible", () => {
    const v = pooledEngagementRate({ impressions: 80, interactions: 80, impressionedPosts: 2 });
    expect(v.rate).toBe(100);
    expect(v.reason).toBeUndefined();
  });

  it("never returns NaN or Infinity for any input combination", () => {
    const inputs = [
      { impressions: 0, interactions: 0, impressionedPosts: 0 },
      { impressions: 0, interactions: 100, impressionedPosts: 5 },
      { impressions: 1, interactions: 0, impressionedPosts: 1 },
      { impressions: 1e9, interactions: 1, impressionedPosts: 1000 },
      { impressions: -5, interactions: 3, impressionedPosts: 1 },
    ];
    for (const i of inputs) {
      const v = pooledEngagementRate(i);
      if (v.rate !== null) {
        expect(Number.isFinite(v.rate)).toBe(true);
        expect(Number.isNaN(v.rate)).toBe(false);
      }
    }
  });

  it("the low-base threshold stays below the smallest prod truth we must render", () => {
    // Bollywood's real 7.02% is pooled over 57 impressions. If the threshold
    // ever rose above that it would decorate (and invite suppressing) a rate
    // this system is required to publish.
    expect(MIN_CONFIDENT_RATE_IMPRESSIONS).toBeLessThanOrEqual(57);
  });
});

describe("computeEngagementRate is UNCHANGED (pinned prod truth)", () => {
  it("still returns the raw pooled ratio, including an impossible 200%", () => {
    // Deliberately kept: this helper is a pure ratio and its existing test is a
    // pinned prod value. The IMPOSSIBILITY rule lives in pooledEngagementRate,
    // so the two are gated separately and neither hides the other's behavior.
    const rows = [{ impressions: 1, likes: 2, comments: 0, shares: 0 }];
    expect(computeEngagementRate(rows)).toBe(200);
    expect(pooledEngagementRate({ impressions: 1, interactions: 2, impressionedPosts: 1 }).rate)
      .toBeNull();
  });
});

describe("group aggregation applies the same verdict", () => {
  const row = (over: Partial<any> = {}) => ({
    channelId: "c1",
    platform: "FACEBOOK",
    impressions: 0,
    reach: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    clicks: 0,
    posts: 10,
    impressionedImpressions: 0,
    impressionedLikes: 0,
    impressionedComments: 0,
    impressionedShares: 0,
    impressionedPosts: 0,
    hasSnapshot: true,
    ...over,
  });

  it("an impossible group total renders null, not 200", () => {
    const groups = sumChannelRowsIntoGroups(
      [{ id: "g1", name: "fb", color: "#000", channels: [{ id: "c1" }] }] as any,
      [row({ impressionedImpressions: 1, impressionedLikes: 2, impressionedPosts: 1 })]
    );
    const g = groups.find((x) => x.id === "g1")!;
    expect(g.engagementRate).toBeNull();
    expect(g.engagementRateFlags.reason).toBe("rate_impossible");
  });

  it("AGGREGATES FIRST: many thin member channels form one legitimate base", () => {
    // Twelve 50-impression channels = a 600-impression group base. Excluding
    // sub-threshold members would understate the group.
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({
        channelId: `c${i}`,
        impressionedImpressions: 50,
        impressionedLikes: 1,
        impressionedPosts: 1,
      })
    );
    const groups = sumChannelRowsIntoGroups(
      [
        { id: "g1", name: "fb", color: "#000", channels: rows.map((r) => ({ id: r.channelId })) },
      ] as any,
      rows
    );
    const g = groups.find((x) => x.id === "g1")!;
    expect(g.engagementRate).toBeCloseTo(2, 5); // 12 / 600
    expect(g.engagementRateFlags.lowBase).toBe(false); // 600 >= 50
  });
});
