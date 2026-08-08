import { describe, it, expect } from "vitest";
import { metricCellValue, likeColumnLabel, engagementRateCell } from "./metric-cell";

describe("metricCellValue", () => {
  it("renders — (null) for every metric when no snapshot captured yet", () => {
    const meta = { hasSnapshot: false };
    for (const k of ["impressions", "reach", "likes", "comments", "shares", "clicks"] as const) {
      expect(metricCellValue(k, 0, meta)).toBeNull();
      expect(metricCellValue(k, 999, meta)).toBeNull(); // even a value → — when no snapshot
    }
  });

  it("renders a captured 0 as a real 0, not —", () => {
    expect(metricCellValue("likes", 0, { hasSnapshot: true })).toBe(0);
  });

  it("renders — for a platform-unavailable metric even with a snapshot", () => {
    const meta = { hasSnapshot: true, unavailable: ["clicks" as const] };
    expect(metricCellValue("clicks", 0, meta)).toBeNull();
    expect(metricCellValue("likes", 5, meta)).toBe(5);
  });

  it("renders — for reach when it is not a distinct metric (aliased from impressions)", () => {
    expect(metricCellValue("reach", 500, { hasSnapshot: true, reachIsDistinct: false })).toBeNull();
    expect(metricCellValue("reach", 500, { hasSnapshot: true, reachIsDistinct: true })).toBe(500);
  });

  it("renders real numbers otherwise", () => {
    expect(metricCellValue("impressions", 1234, { hasSnapshot: true })).toBe(1234);
  });
});

describe("likeColumnLabel", () => {
  it("labels the likes column honestly per platform", () => {
    expect(likeColumnLabel("reactions").label).toBe("Reactions");
    expect(likeColumnLabel("saves").label).toBe("Saves");
    expect(likeColumnLabel("upvotes").label).toBe("Upvotes");
    expect(likeColumnLabel("likes").label).toBe("Likes");
    expect(likeColumnLabel(undefined).label).toBe("Likes");
  });
  it("provides a tooltip for the non-like kinds", () => {
    expect(likeColumnLabel("reactions").tooltip).toBeTruthy();
    expect(likeColumnLabel("likes").tooltip).toBeUndefined();
  });
});

describe("engagementRateCell", () => {
  it('renders "—" for a null rate', () => {
    expect(engagementRateCell({ engagementRate: null }).text).toBeNull();
  });

  it("renders a real 0 as 0.00%, never as —", () => {
    const cell = engagementRateCell({
      engagementRate: 0,
      engagementRateBasis: { impressionedPosts: 5, totalPosts: 5 },
    });
    expect(cell.text).toBe("0.00%");
  });

  it("uses DIFFERENT copy for rate_impossible than for no_basis", () => {
    const impossible = engagementRateCell({
      engagementRate: null,
      engagementRateFlags: { lowBase: false, reason: "rate_impossible" },
    });
    const noBasis = engagementRateCell({
      engagementRate: null,
      engagementRateFlags: { lowBase: false, reason: "no_basis" },
    });
    // "we could not read it" and "we read it and it is impossible" are
    // different facts — reusing one tooltip for the other states a falsehood.
    expect(impossible.title).not.toBe(noBasis.title);
    expect(impossible.title).toMatch(/more interactions than recorded views/i);
    expect(noBasis.title).toMatch(/no denominator|did not report|reported an impression/i);
  });

  it("surfaces the low-base flag while still printing the number", () => {
    const cell = engagementRateCell({
      engagementRate: 11.76,
      engagementRateBasis: { impressionedPosts: 1, totalPosts: 10 },
      engagementRateFlags: { lowBase: true, reason: null },
    });
    expect(cell.text).toBe("11.76%"); // never suppressed
    expect(cell.lowBase).toBe(true);
  });

  it("discloses a partial base and omits it when the base is complete", () => {
    expect(
      engagementRateCell({
        engagementRate: 7.02,
        engagementRateBasis: { impressionedPosts: 1, totalPosts: 13 },
      }).basis
    ).toBe("(1/13)");
    expect(
      engagementRateCell({
        engagementRate: 3.5,
        engagementRateBasis: { impressionedPosts: 8, totalPosts: 8 },
      }).basis
    ).toBeNull();
  });

  it("says 'publish' for group rows and 'post' for channel rows", () => {
    const g = engagementRateCell({ engagementRate: null, unit: "publish" });
    const c = engagementRateCell({ engagementRate: null, unit: "post" });
    expect(g.title).toMatch(/publish/);
    expect(c.title).toMatch(/post/);
  });
});
