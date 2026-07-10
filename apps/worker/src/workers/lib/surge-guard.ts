const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;

/**
 * A volume-surge / negative-spike alert compares the last-24h bucket against
 * the 24-48h-ago bucket. That comparison is only meaningful once the query has
 * been monitoring for the full 48h window — before that, the "previous" bucket
 * is just backfilled historical content, not a real prior baseline.
 */
export function hasSurgeBaseline(queryCreatedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - queryCreatedAt.getTime() >= FORTY_EIGHT_HOURS;
}
