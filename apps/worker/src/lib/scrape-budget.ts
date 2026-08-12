/**
 * Scrape budget + circuit-breaker arithmetic for the external-post sync.
 *
 * Pure so the regression below is locked by a fast unit test — importing the
 * worker drags in BullMQ, Prisma and the whole Graph client.
 *
 * ── The bug this encodes against (measured on prod) ──────────────────────────
 * The breaker exists to detect a soft IP ban: if N consecutive scrapes come back
 * empty, stop scraping for the rest of the run rather than burning the budget
 * and the IP. It used to infer "a scrape missed" from `source !== "scrape"`.
 *
 * That is ALSO what a clean API success looks like. When FB_MEDIA_VIEW_METRICS
 * went live on 2026-08-11 11:35 UTC the provider began returning early with
 * `source: "api"` whenever `post_media_view` yielded a positive count — so five
 * consecutive SUCCESSES tripped the breaker, zeroed the budget, and an up-front
 * `continue` then skipped every remaining reel in the account without measuring
 * it at all.
 *
 * Measured consequence: scrape-sourced captures fell 1,824/h → 0 within the
 * hour and stayed at 0 for a day; 12,845 of 13,615 FB reels (94.3%) went
 * unmeasured or stale, with the backlog GROWING ~163/day (933 new reels/day
 * arriving against ~770 measured).
 *
 * The rule: only a scrape that ACTUALLY RAN can be a miss.
 */

export interface ScrapeBudgetState {
  /** Scrapes still permitted this run. */
  budget: number;
  /** Consecutive scrapes that ran and produced nothing. */
  consecutiveMisses: number;
}

export interface CaptureOutcome {
  /** True only when a scrape was actually executed. Never derive from `source`. */
  scrapeAttempted?: boolean;
  /** Provenance of the stored number. */
  source?: string;
}

export interface ScrapeBudgetStep extends ScrapeBudgetState {
  /** True on the transition that trips the breaker — the caller logs it once. */
  tripped: boolean;
}

/**
 * Advances the budget/breaker after one capture.
 *
 * A capture that did NOT scrape leaves the state completely untouched: it spends
 * no budget and — critically — is not a miss. A capture that scraped spends one
 * unit, resets the miss counter on success, and trips the breaker on the Nth
 * consecutive failure.
 */
export function stepScrapeBudget(
  state: ScrapeBudgetState,
  capture: CaptureOutcome,
  breakerMisses: number
): ScrapeBudgetStep {
  if (!capture.scrapeAttempted) {
    return { ...state, tripped: false };
  }
  const budget = state.budget - 1;
  if (capture.source === "scrape") {
    return { budget, consecutiveMisses: 0, tripped: false };
  }
  const consecutiveMisses = state.consecutiveMisses + 1;
  if (consecutiveMisses >= breakerMisses) {
    return { budget: 0, consecutiveMisses, tripped: true };
  }
  return { budget, consecutiveMisses, tripped: false };
}

/**
 * Whether to leave a row UNMEASURED (skip the write) rather than stamping
 * `metricsSyncedAt` on a capture that carries no view count.
 *
 * Stamping a valueless capture would hide the post behind `needsMetrics` for up
 * to a week; leaving it keeps it at the front of the next run. But this must be
 * decided on EVIDENCE, after the capture — the old code decided it up-front from
 * the budget alone and therefore discarded good API captures too.
 *
 * Defer only when all three hold: the row wanted a view count, no scrape was
 * available to fetch one, and the API declared no impressions either.
 */
export function shouldDeferUnmeasured(
  wantsScrape: boolean,
  scrapeAllowed: boolean,
  impressionsAvailable: boolean | undefined
): boolean {
  return wantsScrape && !scrapeAllowed && impressionsAvailable !== true;
}
