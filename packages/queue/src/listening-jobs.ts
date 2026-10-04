/**
 * Deterministic job ids for listening-sync jobs.
 *
 * The cron used to append `Date.now()`, so BullMQ de-duplication could never
 * fire: a worker that fell behind (deploy drain, Redis blip) accumulated one
 * job per query per 30-minute tick, and each of them ran the full fan-out
 * against the platform APIs when it finally came up. Bucketing the id to the
 * cron interval means at most ONE queued cron job per query per window; a
 * manual "Sync now" gets its own minute bucket so a double click is one job.
 *
 * ⚠️ BullMQ (>= 5.70) rejects custom ids whose colon count is not exactly
 * two — keep every id at THREE colon-separated segments.
 */
export const LISTENING_SYNC_INTERVAL_MS = 30 * 60 * 1000;
const MANUAL_BUCKET_MS = 60 * 1000;

export type ListeningSyncJobKind = "cron" | "manual" | "create";

export function listeningSyncJobId(
  queryId: string,
  kind: ListeningSyncJobKind,
  now: number = Date.now()
): string {
  switch (kind) {
    case "cron":
      return `listening:${queryId}:cron-${Math.floor(now / LISTENING_SYNC_INTERVAL_MS)}`;
    case "manual":
      return `listening:${queryId}:manual-${Math.floor(now / MANUAL_BUCKET_MS)}`;
    case "create":
      return `listening:${queryId}:create`;
  }
}
