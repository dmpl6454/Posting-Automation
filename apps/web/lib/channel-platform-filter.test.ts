import { describe, it, expect } from "vitest";
import {
  platformCounts,
  filterByPlatform,
  computeSelectAll,
  chunkIds,
} from "./channel-platform-filter";

const ch = (id: string, platform: string) => ({ id, platform });

describe("platformCounts", () => {
  it("orders by count desc, then platform A-Z for a stable pill row", () => {
    const channels = [
      ch("1", "FACEBOOK"),
      ch("2", "INSTAGRAM"),
      ch("3", "FACEBOOK"),
      ch("4", "TWITTER"),
      ch("5", "INSTAGRAM"),
      ch("6", "FACEBOOK"),
    ];
    expect(platformCounts(channels)).toEqual([
      { platform: "FACEBOOK", count: 3 },
      { platform: "INSTAGRAM", count: 2 },
      { platform: "TWITTER", count: 1 },
    ]);
  });

  it("breaks count ties alphabetically so pills never reorder between renders", () => {
    const counts = platformCounts([ch("1", "YOUTUBE"), ch("2", "BLUESKY")]);
    expect(counts.map((c) => c.platform)).toEqual(["BLUESKY", "YOUTUBE"]);
  });

  it("tolerates undefined/empty input", () => {
    expect(platformCounts(undefined)).toEqual([]);
    expect(platformCounts([])).toEqual([]);
  });
});

describe("filterByPlatform", () => {
  const channels = [ch("1", "FACEBOOK"), ch("2", "INSTAGRAM"), ch("3", "FACEBOOK")];

  it("returns everything for the All filter (null)", () => {
    expect(filterByPlatform(channels, null).map((c) => c.id)).toEqual(["1", "2", "3"]);
  });

  it("returns only the chosen platform", () => {
    expect(filterByPlatform(channels, "FACEBOOK").map((c) => c.id)).toEqual(["1", "3"]);
    expect(filterByPlatform(channels, "INSTAGRAM").map((c) => c.id)).toEqual(["2"]);
  });

  it("returns empty (never falls back to all) for an unknown platform", () => {
    expect(filterByPlatform(channels, "SNAPCHAT")).toEqual([]);
  });

  it("tolerates undefined input", () => {
    expect(filterByPlatform(undefined, null)).toEqual([]);
    expect(filterByPlatform(null, "FACEBOOK")).toEqual([]);
  });
});

describe("chunkIds (regression guard: the bulk-delete >100 incident)", () => {
  it("never emits a chunk larger than the server cap", () => {
    // 387 = the real FB-Page count on the account that motivated this feature.
    const ids = Array.from({ length: 387 }, (_, i) => `ch-${i}`);
    const chunks = chunkIds(ids, 500);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(387);
    for (const c of chunkIds(ids, 100)) expect(c.length).toBeLessThanOrEqual(100);
  });

  it("splits an over-cap batch and preserves every id exactly once, in order", () => {
    const ids = Array.from({ length: 1250 }, (_, i) => `ch-${i}`);
    const chunks = chunkIds(ids, 500);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 250]);
    expect(chunks.flat()).toEqual(ids);
  });

  it("returns no chunks for an empty batch (caller performs zero calls)", () => {
    expect(chunkIds([], 500)).toEqual([]);
  });

  it("rejects a nonsensical size rather than looping forever", () => {
    expect(() => chunkIds(["a"], 0)).toThrow();
  });
});

describe("computeSelectAll", () => {
  it("selects all visible ids, deduping against the existing selection", () => {
    const r = computeSelectAll(["a", "b", "c"], ["b"]);
    expect(r.allSelected).toBe(false);
    expect(r.selectedVisibleCount).toBe(1);
    expect([...r.next].sort()).toEqual(["a", "b", "c"]);
  });

  it("reports allSelected once every visible id is selected", () => {
    const r = computeSelectAll(["a", "b"], ["a", "b"]);
    expect(r.allSelected).toBe(true);
    expect(r.selectedVisibleCount).toBe(2);
  });

  it("deselect removes ONLY visible ids — selections under other filters survive", () => {
    // User filtered to Instagram (visible a,b), had already picked FB channel z.
    const r = computeSelectAll(["a", "b"], ["a", "b", "z"]);
    expect(r.allSelected).toBe(true);
    expect(r.next).toEqual(["z"]);
  });

  it("never reaches past the filter — hidden ids are not added", () => {
    const r = computeSelectAll(["a"], []);
    expect(r.next).toEqual(["a"]);
    expect(r.next).not.toContain("hidden");
  });

  it("is a no-op-safe false for an empty visible list (button can be disabled)", () => {
    const r = computeSelectAll([], ["x"]);
    expect(r.allSelected).toBe(false);
    expect(r.next).toEqual(["x"]);
  });

  it("does not duplicate when visibleIds itself contains duplicates", () => {
    const r = computeSelectAll(["a", "a", "b"], []);
    expect(r.next).toEqual(["a", "b"]);
  });
});
