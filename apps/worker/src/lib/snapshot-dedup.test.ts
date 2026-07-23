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
});
