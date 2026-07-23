import { describe, it, expect } from "vitest";
import { metricCellValue, likeColumnLabel } from "./metric-cell";

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
