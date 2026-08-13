import { describe, it, expect } from "vitest";
import { planFbAnalyticsRun, type FbAnalyticsCandidate } from "./fb-analytics-budget";

const NOW = new Date("2026-08-13T12:00:00.000Z");
const hAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function cand(
  targetId: string,
  lastSnapshotAt: Date | null,
  over: Partial<FbAnalyticsCandidate> = {}
): FbAnalyticsCandidate {
  return {
    targetId,
    publishedId: `pid-${targetId}`,
    channelId: `chan-${targetId}`,
    lastSnapshotAt,
    ...over,
  };
}

const plan = (candidates: FbAnalyticsCandidate[], over: Partial<Parameters<typeof planFbAnalyticsRun>[0]> = {}) =>
  planFbAnalyticsRun({ candidates, now: NOW, cap: 40, minStaleHours: 48, ...over });

describe("planFbAnalyticsRun", () => {
  describe("eligibility", () => {
    it("drops a target with no publishedId — it cannot be measured at all", () => {
      const r = plan([cand("a", null, { publishedId: null })]);
      expect(r.selected).toHaveLength(0);
      expect(r.ineligible).toBe(1);
      // Not 'deferred': deferring implies we will get to it later, which is false.
      expect(r.deferred).toBe(0);
    });

    it("skips a target measured more recently than minStaleHours", () => {
      const r = plan([cand("fresh", hAgo(2)), cand("stale", hAgo(100))]);
      expect(r.selected.map((c) => c.targetId)).toEqual(["stale"]);
      expect(r.freshSkipped).toBe(1);
    });

    it("treats exactly-at-the-threshold as stale enough (inclusive)", () => {
      const r = plan([cand("edge", hAgo(48))]);
      expect(r.selected.map((c) => c.targetId)).toEqual(["edge"]);
      expect(r.freshSkipped).toBe(0);
    });
  });

  describe("ordering — stalest first, never-measured worst-off", () => {
    it("puts never-measured targets ahead of measured ones", () => {
      const r = plan([cand("measured-old", hAgo(500)), cand("never", null)]);
      expect(r.selected.map((c) => c.targetId)).toEqual(["never", "measured-old"]);
    });

    it("orders measured targets oldest-snapshot-first", () => {
      const r = plan([cand("recent", hAgo(50)), cand("ancient", hAgo(3000)), cand("mid", hAgo(200))]);
      expect(r.selected.map((c) => c.targetId)).toEqual(["ancient", "mid", "recent"]);
    });

    it("breaks ties deterministically by targetId so runs are reproducible", () => {
      const same = hAgo(100);
      const a = plan([cand("zzz", same), cand("aaa", same), cand("mmm", same)]);
      expect(a.selected.map((c) => c.targetId)).toEqual(["aaa", "mmm", "zzz"]);
    });
  });

  describe("budget — a cap that only DEFERS, never drops", () => {
    it("selects at most cap and reports the remainder as deferred", () => {
      const many = Array.from({ length: 10 }, (_, i) => cand(`t${i}`, hAgo(1000 - i)));
      const r = plan(many, { cap: 3 });
      expect(r.selected).toHaveLength(3);
      expect(r.deferred).toBe(7);
      expect(r.selected.length + r.deferred + r.freshSkipped + r.ineligible).toBe(10);
    });

    it("a cap of 0 selects nothing and defers everything (kill-switch-by-budget)", () => {
      const r = plan([cand("a", null), cand("b", hAgo(99))], { cap: 0 });
      expect(r.selected).toHaveLength(0);
      expect(r.deferred).toBe(2);
    });
  });

  describe("STARVATION GUARD — never-measured targets must not monopolise the budget", () => {
    // A permanently-failing target (dead token, deleted post) never gets a
    // snapshot written: analytics-sync.worker returns null WITHOUT writing for
    // untagged cron jobs. So its lastSnapshotAt stays null forever and pure
    // stalest-first ordering would re-pick it every single run, starving the
    // healthy targets behind it. This is the DATA_ACCESS_RECHECK_COOLDOWN_MS
    // lesson ("don't re-probe a token that just failed; it starves the live
    // ones") applied to target selection.
    it("reserves part of the budget for measured-but-stale targets", () => {
      const dead = Array.from({ length: 50 }, (_, i) => cand(`dead${i}`, null));
      const alive = Array.from({ length: 50 }, (_, i) => cand(`alive${i}`, hAgo(500 + i)));
      const r = plan([...dead, ...alive], { cap: 10, neverMeasuredShare: 0.5 });

      const chosen = r.selected.map((c) => c.targetId);
      const nNever = chosen.filter((id) => id.startsWith("dead")).length;
      const nMeasured = chosen.filter((id) => id.startsWith("alive")).length;

      expect(r.selected).toHaveLength(10);
      expect(nNever).toBe(5);
      expect(nMeasured).toBe(5);
    });

    it("does NOT waste budget when there are too few measured targets to fill the reserve", () => {
      const dead = Array.from({ length: 50 }, (_, i) => cand(`dead${i}`, null));
      const r = plan([...dead, cand("alive0", hAgo(500))], { cap: 10, neverMeasuredShare: 0.5 });
      // Only 1 measured candidate exists; the other 9 slots go to never-measured
      // rather than sitting idle. A reserve is a floor for the minority, not a
      // ceiling that throws away capacity.
      expect(r.selected).toHaveLength(10);
      expect(r.selected.filter((c) => c.lastSnapshotAt === null)).toHaveLength(9);
    });

    it("gives never-measured the whole budget when there are no measured candidates", () => {
      const dead = Array.from({ length: 5 }, (_, i) => cand(`dead${i}`, null));
      const r = plan(dead, { cap: 3, neverMeasuredShare: 0.5 });
      expect(r.selected).toHaveLength(3);
      expect(r.deferred).toBe(2);
    });
  });

  describe("accounting is exhaustive — every candidate lands in exactly one bucket", () => {
    it("selected + deferred + freshSkipped + ineligible === candidates.length", () => {
      const mixed = [
        cand("no-pid", null, { publishedId: null }),
        cand("fresh1", hAgo(1)),
        cand("fresh2", hAgo(47)),
        cand("never1", null),
        cand("never2", null),
        cand("stale1", hAgo(120)),
        cand("stale2", hAgo(900)),
      ];
      const r = plan(mixed, { cap: 2 });
      expect(r.selected.length + r.deferred + r.freshSkipped + r.ineligible).toBe(mixed.length);
      expect(r.ineligible).toBe(1);
      expect(r.freshSkipped).toBe(2);
    });

    it("handles an empty candidate list without throwing", () => {
      const r = plan([]);
      expect(r).toEqual({ selected: [], deferred: 0, freshSkipped: 0, ineligible: 0 });
    });
  });
});