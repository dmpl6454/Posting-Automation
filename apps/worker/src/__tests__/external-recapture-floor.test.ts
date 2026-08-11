import { describe, it, expect } from "vitest";
import { needsMetrics } from "../workers/external-post-sync.worker";

/**
 * The backfill mechanism: a one-shot `EXTERNAL_RECAPTURE_BEFORE` floor on the
 * existing decay cadence. No new job, no new column — `metricsSyncedAt` is the
 * self-clearing progress marker.
 */

const NOW = new Date("2026-08-11T12:00:00Z");
const h = (n: number) => new Date(NOW.getTime() - n * 3_600_000);

describe("needsMetrics — decay cadence unchanged when no floor is set", () => {
  it("never-measured is always due", () => {
    expect(needsMetrics(h(1000), null, NOW, null)).toBe(true);
  });

  it("fresh post (<=48h): every 6h", () => {
    expect(needsMetrics(h(10), h(5), NOW, null)).toBe(false);
    expect(needsMetrics(h(10), h(7), NOW, null)).toBe(true);
  });

  it("first week: daily", () => {
    expect(needsMetrics(h(72), h(20), NOW, null)).toBe(false);
    expect(needsMetrics(h(72), h(25), NOW, null)).toBe(true);
  });

  it("older: weekly", () => {
    expect(needsMetrics(h(24 * 20), h(24 * 6), NOW, null)).toBe(false);
    expect(needsMetrics(h(24 * 20), h(24 * 8), NOW, null)).toBe(true);
  });
});

describe("needsMetrics — recapture floor", () => {
  const floor = new Date("2026-08-11T00:00:00Z");

  it("🔴 re-measures a capture taken BEFORE the floor even when the cadence says no", () => {
    // A month-old post measured 2h ago: the weekly rule would defer it for ~7 days.
    // The floor must win, otherwise a capability change takes a week to land.
    const measuredBeforeFloor = new Date("2026-08-10T23:00:00Z");
    expect(needsMetrics(h(24 * 20), measuredBeforeFloor, NOW, null)).toBe(false); // cadence alone
    expect(needsMetrics(h(24 * 20), measuredBeforeFloor, NOW, floor)).toBe(true); // floor wins
  });

  it("does NOT re-measure a capture taken after the floor — the sweep converges", () => {
    // This is what makes it self-clearing: a re-measured row moves past the floor.
    const measuredAfterFloor = new Date("2026-08-11T09:00:00Z");
    expect(needsMetrics(h(24 * 20), measuredAfterFloor, NOW, floor)).toBe(false);
  });

  it("is idempotent: a second pass over an already-recaptured row is a no-op", () => {
    const first = needsMetrics(h(24 * 20), new Date("2026-08-10T00:00:00Z"), NOW, floor);
    expect(first).toBe(true);
    // after the recapture, metricsSyncedAt is `now`
    expect(needsMetrics(h(24 * 20), NOW, NOW, floor)).toBe(false);
  });

  it("still short-circuits never-measured rows (floor is additive, not a filter)", () => {
    expect(needsMetrics(h(24 * 20), null, NOW, floor)).toBe(true);
  });

  it("a floor in the past that predates every capture changes nothing", () => {
    const ancient = new Date("2020-01-01T00:00:00Z");
    expect(needsMetrics(h(10), h(1), NOW, ancient)).toBe(false);
  });
});
