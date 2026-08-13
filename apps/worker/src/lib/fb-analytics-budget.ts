/**
 * Budgeted selection for the low-frequency Facebook analytics pass.
 *
 * WHY THIS EXISTS
 * ---------------
 * `scheduleAnalyticsSync` (6-hourly) and `scheduleLongTailAnalyticsSync`
 * (daily) both filter `platform: { not: "FACEBOOK" }`, so an app-published
 * Facebook target is refreshed ONLY by its publish-time snapshot and its four
 * at-age checkpoints (24h/7d/15d/30d). Once the 30d checkpoint passes, nothing
 * refreshes it again — measured 2026-08-13: FB targets older than 30 days
 * carried snapshots averaging ~130 days old, and every live target crosses that
 * cliff on a rolling 30-day basis.
 *
 * The exclusion is NOT merely a quota decision and must not simply be deleted:
 * `usageCache` in facebook.provider.ts is MODULE-GLOBAL and post-publish runs
 * in the SAME process as analytics-sync. The publish path passes no
 * `maxSleepMs`, so once app usage reads >=95% every publish Graph call sleeps an
 * uncapped 60s. FB analytics volume can therefore stall PUBLISHING, which is a
 * hard red line. Hence a pass that is low-frequency, hard-capped, and ordered
 * so the cap only ever DEFERS work.
 *
 * "A cap that changes a displayed value is a bug; one that only defers a value
 * is a budget." (external-post-sync.worker.ts). Every FB target's metrics are
 * eventually refreshed; the cap only decides in which order.
 *
 * Pure + testable on purpose — importing the cron module drags in BullMQ,
 * Prisma and the whole Graph client.
 */

export interface FbAnalyticsCandidate {
  targetId: string;
  /** Platform post id. NULL ⇒ unmeasurable, not merely deferred. */
  publishedId: string | null;
  channelId: string;
  /** Latest AnalyticsSnapshot.snapshotAt for this target; NULL ⇒ never captured. */
  lastSnapshotAt: Date | null;
}

export interface FbAnalyticsPlan {
  /** Targets to enqueue this run, in the order they should be enqueued. */
  selected: FbAnalyticsCandidate[];
  /** Eligible and stale, but beyond this run's budget. Picked up next run. */
  deferred: number;
  /** Measured recently enough that re-measuring would be churn. */
  freshSkipped: number;
  /** Cannot be measured at all (no platform post id). */
  ineligible: number;
}

/**
 * Fraction of the budget that never-measured targets may claim before the
 * remainder is reserved for measured-but-stale ones.
 *
 * ⚠️ STARVATION GUARD — do not set this to 1. A permanently-failing target (dead
 * token, deleted post) never gets a snapshot written at all: for an untagged
 * cron job, analytics-sync.worker returns null WITHOUT writing on both the throw
 * path and the null-analytics path. Its `lastSnapshotAt` therefore stays NULL
 * forever, and pure stalest-first ordering would re-select it on every single
 * run, permanently starving the healthy targets queued behind it. This is the
 * `DATA_ACCESS_RECHECK_COOLDOWN_MS` lesson — "don't re-probe a token that just
 * failed; it starves the live ones" — applied to target selection.
 *
 * The reserve is a FLOOR for the minority, never a ceiling on capacity: unused
 * slots on either side are backfilled to the other, so a run is never short.
 */
export const DEFAULT_NEVER_MEASURED_SHARE = 0.5;

const ageHours = (from: Date, now: Date) => (now.getTime() - from.getTime()) / 3_600_000;

/** Oldest snapshot first; `targetId` breaks ties so runs are reproducible. */
function byStalestThenId(a: FbAnalyticsCandidate, b: FbAnalyticsCandidate): number {
  const at = a.lastSnapshotAt?.getTime() ?? 0;
  const bt = b.lastSnapshotAt?.getTime() ?? 0;
  if (at !== bt) return at - bt;
  return a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0;
}

export function planFbAnalyticsRun(opts: {
  candidates: FbAnalyticsCandidate[];
  now: Date;
  /** Hard per-run ceiling on enqueued targets. */
  cap: number;
  /** Don't re-measure a target captured more recently than this. */
  minStaleHours: number;
  neverMeasuredShare?: number;
}): FbAnalyticsPlan {
  const { candidates, now, cap, minStaleHours } = opts;
  const share = opts.neverMeasuredShare ?? DEFAULT_NEVER_MEASURED_SHARE;

  let ineligible = 0;
  let freshSkipped = 0;
  const never: FbAnalyticsCandidate[] = [];
  const measured: FbAnalyticsCandidate[] = [];

  for (const c of candidates) {
    if (!c.publishedId) {
      ineligible++;
      continue;
    }
    if (c.lastSnapshotAt === null) {
      never.push(c);
      continue;
    }
    // `>=` so a target sitting exactly on the threshold is refreshed rather
    // than deferred another whole cycle.
    if (ageHours(c.lastSnapshotAt, now) >= minStaleHours) {
      measured.push(c);
    } else {
      freshSkipped++;
    }
  }

  never.sort(byStalestThenId);
  measured.sort(byStalestThenId);

  const safeCap = Math.max(0, Math.floor(cap));
  const neverBudget = Math.floor(safeCap * share);
  const measuredFloor = safeCap - neverBudget;

  // Take each side's guaranteed share, then backfill whatever the other side
  // could not use — the reserve must not idle capacity.
  let measuredTake = Math.min(measured.length, measuredFloor);
  const neverTake = Math.min(never.length, safeCap - measuredTake);
  measuredTake = Math.min(measured.length, safeCap - neverTake);

  // Never-measured first: they are the worst-off (nothing at all to show).
  const selected = [...never.slice(0, neverTake), ...measured.slice(0, measuredTake)];

  return {
    selected,
    deferred: never.length + measured.length - selected.length,
    freshSkipped,
    ineligible,
  };
}