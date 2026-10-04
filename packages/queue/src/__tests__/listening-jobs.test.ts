import { describe, it, expect } from "vitest";
import { listeningSyncJobId, LISTENING_SYNC_INTERVAL_MS } from "../listening-jobs";

describe("listeningSyncJobId", () => {
  it("every kind has exactly three colon segments (BullMQ custom-id rule)", () => {
    for (const kind of ["cron", "manual", "create"] as const) {
      expect(listeningSyncJobId("q1", kind, 1_700_000_000_000).split(":")).toHaveLength(3);
    }
  });
  it("cron ids are identical inside one 30-minute window and differ across windows", () => {
    // Aligned to a window start so "+ interval - 1" stays inside the same bucket.
    const t = Math.floor(1_700_000_000_000 / LISTENING_SYNC_INTERVAL_MS) * LISTENING_SYNC_INTERVAL_MS;
    expect(listeningSyncJobId("q1", "cron", t)).toBe(listeningSyncJobId("q1", "cron", t + LISTENING_SYNC_INTERVAL_MS - 1));
    expect(listeningSyncJobId("q1", "cron", t)).not.toBe(listeningSyncJobId("q1", "cron", t + LISTENING_SYNC_INTERVAL_MS));
  });
  it("manual ids collapse a double click within a minute, never across queries", () => {
    const t = Math.floor(1_700_000_000_000 / 60_000) * 60_000;
    expect(listeningSyncJobId("q1", "manual", t)).toBe(listeningSyncJobId("q1", "manual", t + 59_000));
    expect(listeningSyncJobId("q1", "manual", t)).not.toBe(listeningSyncJobId("q2", "manual", t));
  });
  it("never embeds a raw timestamp", () => {
    expect(listeningSyncJobId("q1", "cron", 1_700_000_000_000)).not.toContain("1700000000000");
  });
});
