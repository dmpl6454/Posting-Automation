/**
 * Decides whether a freshly-fetched analytics result is worth writing as a new
 * AnalyticsSnapshot, or is identical to the latest stored one and can be
 * skipped. This stops the table from bloating with duplicate all-zero rows —
 * prod had 47 snapshots per FB target, almost all identical zeros, because
 * every cron pass wrote a row regardless of whether anything changed.
 *
 * Checkpoint jobs (windowTag set) ALWAYS write — Reports' at-age mode needs a
 * row pinned at exactly 24h/7d/15d/30d even if the numbers didn't move.
 *
 * Pure + testable.
 */
export interface SnapshotMetrics {
  impressions: number;
  clicks: number;
  likes: number;
  shares: number;
  comments: number;
  reach: number;
}

const KEYS: (keyof SnapshotMetrics)[] = [
  "impressions",
  "clicks",
  "likes",
  "shares",
  "comments",
  "reach",
];

function norm(v: number | null | undefined): number {
  return typeof v === "number" ? v : 0;
}

export function shouldWriteSnapshot(
  next: Partial<SnapshotMetrics>,
  latest: Partial<SnapshotMetrics> | null | undefined,
  hasWindowTag: boolean
): boolean {
  // Checkpoint jobs must always persist a row (at-age pinning).
  if (hasWindowTag) return true;
  // No prior snapshot → always write the first one.
  if (!latest) return true;
  // Skip only when every metric is unchanged from the latest snapshot.
  for (const k of KEYS) {
    if (norm(next[k]) !== norm(latest[k])) return true;
  }
  return false;
}
