import { describe, it, expect } from "vitest";
import { shouldWriteSnapshot } from "./snapshot-dedup";

const M = (o: Partial<Record<string, number>> = {}) => ({
  impressions: 0, clicks: 0, likes: 0, shares: 0, comments: 0, reach: 0, ...o,
});

describe("shouldWriteSnapshot", () => {
  it("always writes a checkpoint (windowTag) job even when unchanged", () => {
    expect(shouldWriteSnapshot(M(), M(), true)).toBe(true);
  });

  it("always writes the first snapshot (no latest)", () => {
    expect(shouldWriteSnapshot(M({ likes: 5 }), null, false)).toBe(true);
    expect(shouldWriteSnapshot(M(), undefined, false)).toBe(true);
  });

  it("skips a cron write when every metric is unchanged (the 47x-bloat fix)", () => {
    expect(shouldWriteSnapshot(M({ impressions: 100, likes: 3 }), M({ impressions: 100, likes: 3 }), false)).toBe(false);
    // all-zero repeat (the common FB case) is skipped
    expect(shouldWriteSnapshot(M(), M(), false)).toBe(false);
  });

  it("writes when any metric changed", () => {
    expect(shouldWriteSnapshot(M({ likes: 4 }), M({ likes: 3 }), false)).toBe(true);
    expect(shouldWriteSnapshot(M({ reach: 1 }), M({ reach: 0 }), false)).toBe(true);
  });

  it("treats null/undefined metrics as 0 for comparison", () => {
    expect(shouldWriteSnapshot({ likes: 0 }, { impressions: 0 } as any, false)).toBe(false);
  });

  // ── capability-change writes (2026-08-06) ────────────────────────────────
  // Dedup used to compare ONLY the six numbers, which stranded channels the
  // owner had just fixed: an under-scoped token stored all-zeros with
  // metricsAvailable:{…false}; after reconnecting, a post whose true engagement
  // is genuinely 0 yields the SAME six numbers, so nothing was written and the
  // stale "unavailable" metadata kept the UI showing "—" instead of a real 0.
  // Zero-engagement posts are the common case on fresh pages, so this was the
  // norm rather than an edge case.
  describe("capability changes", () => {
    it("WRITES when a metric flipped unavailable → available, numbers unchanged", () => {
      expect(
        shouldWriteSnapshot(
          { ...M(), metricsAvailable: { impressions: true, clicks: true } },
          { ...M(), metadata: { metricsAvailable: { impressions: false, clicks: false } } },
          false
        )
      ).toBe(true);
    });

    it("WRITES when a metric flipped available → unavailable (token went stale)", () => {
      expect(
        shouldWriteSnapshot(
          { ...M(), metricsAvailable: { clicks: false } },
          { ...M(), metadata: { metricsAvailable: { clicks: true } } },
          false
        )
      ).toBe(true);
    });

    it("WRITES when the capture starts declaring availability at all (legacy row)", () => {
      expect(
        shouldWriteSnapshot(
          { ...M(), metricsAvailable: { impressions: true } },
          { ...M(), metadata: null },
          false
        )
      ).toBe(true);
    });

    it("still SKIPS when both numbers and the capability claim are identical", () => {
      expect(
        shouldWriteSnapshot(
          { ...M({ impressions: 100 }), metricsAvailable: { impressions: true, reach: false } },
          { ...M({ impressions: 100 }), metadata: { metricsAvailable: { reach: false, impressions: true } } },
          false
        )
      ).toBe(false);
    });

    it("ignores unrelated metadata keys — only metricsAvailable matters", () => {
      // windowTag/source/saved churn must not resurrect the 47x snapshot bloat.
      expect(
        shouldWriteSnapshot(
          { ...M(), metricsAvailable: { clicks: false } },
          { ...M(), metadata: { metricsAvailable: { clicks: false }, source: "scrape", saved: 9 } },
          false
        )
      ).toBe(false);
    });

    it("survives malformed stored metadata without writing spuriously", () => {
      expect(shouldWriteSnapshot({ ...M() }, { ...M(), metadata: "garbled" }, false)).toBe(false);
      expect(shouldWriteSnapshot({ ...M() }, { ...M(), metadata: [1, 2] }, false)).toBe(false);
    });

    it("is byte-identical to legacy behavior when neither side declares availability", () => {
      expect(shouldWriteSnapshot(M(), M(), false)).toBe(false);
      expect(shouldWriteSnapshot(M({ likes: 1 }), M(), false)).toBe(true);
    });
  });
});
