import { describe, it, expect } from "vitest";
import { computeEngagementRate } from "../lib/engagement-rate";

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
