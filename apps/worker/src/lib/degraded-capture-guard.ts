/**
 * Should a DEGRADED analytics capture be persisted as a snapshot?
 *
 * ── The incident this prevents (root-caused on prod 2026-08-25) ───────────────
 * When a Graph call degrades — a rejected token, or media that no longer exists —
 * `getPostAnalytics` returns a result whose metrics are all zero plus a `degraded`
 * marker. The worker wrote that as a normal snapshot, and because every read path
 * selected the NEWEST snapshot per target, the zero row became the displayed value
 * and buried the real numbers captured earlier.
 *
 * That burial is permanent for a post deleted on the platform: it can never be
 * re-measured, so nothing will ever replace the zeros. Measured on production: 64
 * Instagram targets carried a degraded latest snapshot, and 25 of them were hiding
 * **68,276 views and 630 likes** behind zeros.
 *
 * Live-probed before changing anything, so the cause is established rather than
 * assumed: the accounts' tokens answered normally (`archivebollywood`
 * media_count=10,717) while the stored media ids returned Graph `#100/33 "Object ...
 * does not exist"`. The app's permissions were never at fault — our own zero-write
 * was erasing the history from view.
 *
 * The read path now prefers the last clean snapshot, which repairs existing rows.
 * This guard is the other half: stop manufacturing those rows, so the table does not
 * accumulate zeroed duplicates and "latest" keeps meaning something.
 *
 * Pure + testable, mirroring snapshot-dedup.ts.
 */
export interface DegradedCaptureContext {
  /** Did this capture come back degraded (token rejected, media gone, …)? */
  degraded: boolean;
  /** Does a NON-degraded snapshot already exist for this target? */
  hasCleanSnapshot: boolean;
  /**
   * Is this an at-age checkpoint job (metadata.windowTag)?
   *
   * ⚠️ Checkpoints are EXEMPT. Reports' at-age mode pins a row at exactly
   * 24h/7d/15d/30d; skipping one loses that checkpoint forever, and a checkpoint
   * recording "we could not measure this" is itself meaningful there.
   */
  isCheckpoint: boolean;
}

export function shouldWriteDegradedSnapshot(ctx: DegradedCaptureContext): boolean {
  // A clean capture — including a genuine all-zero one — is always written, so the
  // normal path is untouched.
  if (!ctx.degraded) return true;
  if (ctx.isCheckpoint) return true;
  // A first failing capture is still information: it establishes hasSnapshot and
  // carries the degradation reason behind the reconnect banner. Only refuse to let
  // a failure REPLACE something better.
  return !ctx.hasCleanSnapshot;
}
