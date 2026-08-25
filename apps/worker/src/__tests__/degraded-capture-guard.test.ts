import { describe, it, expect } from "vitest";
import { shouldWriteDegradedSnapshot } from "../lib/degraded-capture-guard";

/**
 * A DEGRADED capture must not overwrite data we already hold.
 *
 * Root-caused on prod 2026-08-25. When a Graph call degrades (rejected token,
 * deleted media) the worker still wrote a snapshot with every metric ZERO. Because
 * every read path took the newest snapshot, that zero row became the displayed value
 * and buried the real numbers captured earlier — permanently, since a post deleted on
 * the platform can never be re-measured. Measured: 64 Instagram targets held a
 * degraded latest snapshot, 25 of them burying 68,276 views and 630 likes.
 *
 * The read path now prefers the last clean snapshot, which repairs the existing rows.
 * This guard is the other half: stop manufacturing the rows at all, so the table does
 * not fill with zeroed duplicates and "latest" keeps meaning something.
 *
 * ⚠️ Checkpoint (windowTag) jobs are EXEMPT. At-age mode needs a row pinned at exactly
 * 24h/7d/15d/30d, and its absence is itself meaningful there.
 */
describe("shouldWriteDegradedSnapshot", () => {
  it("writes a degraded capture when we have NOTHING else", () => {
    // First capture failing is still information: it establishes hasSnapshot and
    // carries the degradation reason that drives the reconnect banner.
    expect(shouldWriteDegradedSnapshot({ degraded: true, hasCleanSnapshot: false, isCheckpoint: false })).toBe(true);
  });

  it("SKIPS a degraded capture when a clean snapshot already exists", () => {
    // The case that caused the incident.
    expect(shouldWriteDegradedSnapshot({ degraded: true, hasCleanSnapshot: true, isCheckpoint: false })).toBe(false);
  });

  it("always writes a checkpoint capture, degraded or not", () => {
    // at_age pins a row per window; skipping would lose the checkpoint forever.
    expect(shouldWriteDegradedSnapshot({ degraded: true, hasCleanSnapshot: true, isCheckpoint: true })).toBe(true);
  });

  it("never interferes with a clean capture", () => {
    // Clean captures — including a genuine all-zero one — are unaffected in every
    // combination, so normal behavior is byte-identical.
    for (const hasClean of [true, false]) {
      for (const isCheckpoint of [true, false]) {
        expect(
          shouldWriteDegradedSnapshot({ degraded: false, hasCleanSnapshot: hasClean, isCheckpoint })
        ).toBe(true);
      }
    }
  });
});
