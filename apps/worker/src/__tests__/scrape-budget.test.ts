import { describe, it, expect } from "vitest";
import { stepScrapeBudget, shouldDeferUnmeasured } from "../lib/scrape-budget";

/**
 * Locks the fix for the 2026-08-11 reel-measurement collapse.
 *
 * The breaker counted `source !== "scrape"` as a scrape MISS. That is also what
 * a clean API success looks like, so once the media-view metrics started
 * answering, five consecutive SUCCESSES tripped the breaker and the pipeline
 * stopped measuring reels. Prod evidence: scrape-sourced captures 1,824/h → 0
 * inside the flag-flip hour, 94.3% of FB reels unmeasured, backlog growing.
 */
const BREAKER = 5;
const start = { budget: 40, consecutiveMisses: 0 };

describe("stepScrapeBudget", () => {
  /**
   * `stepScrapeBudget` is new code, so there is no pre-fix unit to run this
   * against. Instead the OLD predicate is reproduced literally here, so the
   * regression is visible in the test file itself rather than only in a commit
   * message. This is the exact expression the worker used to evaluate.
   */
  it("🔴 REGRESSION WITNESS: the old rule counted a clean API success as a miss", () => {
    const oldRuleSaysMiss = (c: { source?: string }) => c.source !== "scrape";
    const cleanApiSuccess = { scrapeAttempted: false, source: "api" };

    // What the pipeline used to conclude — and why five successes killed it:
    expect(oldRuleSaysMiss(cleanApiSuccess)).toBe(true);

    // What it concludes now:
    expect(stepScrapeBudget(start, cleanApiSuccess, BREAKER).consecutiveMisses).toBe(0);
  });

  it("🔴 an API success that never scraped is NOT a miss and spends NO budget", () => {
    // The regression: this capture used to increment consecutiveMisses.
    const s = stepScrapeBudget(start, { scrapeAttempted: false, source: "api" }, BREAKER);
    expect(s).toEqual({ budget: 40, consecutiveMisses: 0, tripped: false });
  });

  it("🔴 five consecutive API successes do NOT trip the breaker", () => {
    let s = { ...start };
    for (let i = 0; i < 5; i++) {
      const next = stepScrapeBudget(s, { scrapeAttempted: false, source: "api" }, BREAKER);
      expect(next.tripped).toBe(false);
      s = { budget: next.budget, consecutiveMisses: next.consecutiveMisses };
    }
    expect(s.budget).toBe(40);
    expect(s.consecutiveMisses).toBe(0);
  });

  it("a scrape that ran and produced nothing IS a miss and spends budget", () => {
    const s = stepScrapeBudget(start, { scrapeAttempted: true, source: "api" }, BREAKER);
    expect(s).toEqual({ budget: 39, consecutiveMisses: 1, tripped: false });
  });

  it("a successful scrape resets the miss counter", () => {
    const s = stepScrapeBudget(
      { budget: 30, consecutiveMisses: 3 },
      { scrapeAttempted: true, source: "scrape" },
      BREAKER
    );
    expect(s).toEqual({ budget: 29, consecutiveMisses: 0, tripped: false });
  });

  it("still trips on a genuine soft IP ban — N consecutive real scrape misses", () => {
    let s = { ...start };
    let tripped = false;
    for (let i = 0; i < BREAKER; i++) {
      const next = stepScrapeBudget(s, { scrapeAttempted: true, source: "api" }, BREAKER);
      tripped = next.tripped;
      s = { budget: next.budget, consecutiveMisses: next.consecutiveMisses };
    }
    expect(tripped).toBe(true);
    expect(s.budget).toBe(0); // budget zeroed for the rest of the run
    expect(s.consecutiveMisses).toBe(BREAKER);
  });

  it("interleaving successes does not accumulate toward the breaker", () => {
    let s = { ...start };
    for (const capture of [
      { scrapeAttempted: true, source: "api" }, // miss
      { scrapeAttempted: true, source: "scrape" }, // success -> reset
      { scrapeAttempted: true, source: "api" }, // miss
      { scrapeAttempted: false, source: "api" }, // no scrape -> untouched
    ]) {
      const next = stepScrapeBudget(s, capture, BREAKER);
      expect(next.tripped).toBe(false);
      s = { budget: next.budget, consecutiveMisses: next.consecutiveMisses };
    }
    expect(s.consecutiveMisses).toBe(1);
    expect(s.budget).toBe(37); // 3 scrapes ran, the 4th did not
  });

  it("an undefined scrapeAttempted (a provider that never scrapes) is inert", () => {
    // IG/YouTube providers return no such flag; they must not consume budget.
    const s = stepScrapeBudget(start, { source: "api" }, BREAKER);
    expect(s).toEqual({ budget: 40, consecutiveMisses: 0, tripped: false });
  });
});

describe("shouldDeferUnmeasured", () => {
  it("defers only when a view count was wanted, unscrapeable, AND absent from the API", () => {
    expect(shouldDeferUnmeasured(true, false, undefined)).toBe(true);
    expect(shouldDeferUnmeasured(true, false, false)).toBe(true);
  });

  it("🔴 does NOT discard a good API capture just because the scrape budget is gone", () => {
    // The old up-front `continue` threw this measurement away.
    expect(shouldDeferUnmeasured(true, false, true)).toBe(false);
  });

  it("never defers when a scrape was still available (the capture had its chance)", () => {
    expect(shouldDeferUnmeasured(true, true, undefined)).toBe(false);
    expect(shouldDeferUnmeasured(true, true, false)).toBe(false);
  });

  it("never defers a row that did not want a view count", () => {
    for (const allowed of [true, false]) {
      for (const avail of [true, false, undefined]) {
        expect(shouldDeferUnmeasured(false, allowed, avail)).toBe(false);
      }
    }
  });
});
