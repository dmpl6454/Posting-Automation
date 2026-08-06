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

type AvailabilityMap = Record<string, boolean> | undefined;

/** Reads metricsAvailable out of a stored snapshot's untyped metadata JSON. */
function storedAvailability(metadata: unknown): AvailabilityMap {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const m = (metadata as Record<string, unknown>).metricsAvailable;
  if (!m || typeof m !== "object" || Array.isArray(m)) return undefined;
  return m as Record<string, boolean>;
}

/**
 * True when the CAPABILITY claim changed, even if every number is identical.
 *
 * ⚠️ Load-bearing after the 2026-08-06 permission approval. Dedup used to compare
 * only the six metric numbers, which silently stranded newly-fixed channels:
 * a channel whose token was under-scoped stored all-zeros with
 * `metricsAvailable: {…false}`, and once the owner RECONNECTED, a post whose
 * true engagement is genuinely 0 produced the identical six numbers — so no new
 * snapshot was written, the stale "unavailable" metadata persisted, and the UI
 * kept rendering "—" instead of the truthful "0" indefinitely. Zero-engagement
 * posts are the COMMON case on fresh/low-traffic pages, so this was the norm,
 * not an edge case.
 */
function availabilityChanged(next: AvailabilityMap, stored: AvailabilityMap): boolean {
  // Nothing declared on either side → no capability change to record.
  if (!next && !stored) return false;
  // One side declares and the other doesn't → the claim changed.
  if (!next || !stored) return true;
  const keys = new Set([...Object.keys(next), ...Object.keys(stored)]);
  for (const k of keys) {
    if (next[k] !== stored[k]) return true;
  }
  return false;
}

export function shouldWriteSnapshot(
  next: Partial<SnapshotMetrics> & { metricsAvailable?: Record<string, boolean> },
  latest: (Partial<SnapshotMetrics> & { metadata?: unknown }) | null | undefined,
  hasWindowTag: boolean
): boolean {
  // Checkpoint jobs must always persist a row (at-age pinning).
  if (hasWindowTag) return true;
  // No prior snapshot → always write the first one.
  if (!latest) return true;
  // Any metric moved → write.
  for (const k of KEYS) {
    if (norm(next[k]) !== norm(latest[k])) return true;
  }
  // Numbers identical, but what the platform is WILLING to report changed
  // (e.g. the owner reconnected and a metric flipped unavailable → available).
  // Without this the UI would keep showing "—" for a real, captured 0.
  if (availabilityChanged(next.metricsAvailable, storedAvailability(latest.metadata))) return true;
  return false;
}
