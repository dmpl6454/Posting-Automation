/**
 * Publish claims held by THIS PROCESS (targetId → number of holders),
 * 2026-09-16.
 *
 * BullMQ's active list is the cross-process record of who is working on a
 * target, but it has one blind spot: if a job's lock lapses, BullMQ can re-run
 * the SAME job id while the first run is still publishing, and a check that
 * filters the active list by job id then hides that first run. This registry
 * covers that case for the claim-miss orphan check (post-publish.worker.ts) and
 * the stuck-PUBLISHING reaper (auto-healer.worker.ts), which run in the same
 * process.
 *
 * ⚠️ Per process only. It does not cover a lost-lock re-run on ANOTHER worker
 * replica; there is one worker container today (see CRON_LEADER in index.ts).
 */

const holders = new Map<string, number>();

export function addLocalClaim(postTargetId: string): void {
  holders.set(postTargetId, (holders.get(postTargetId) ?? 0) + 1);
}

export function releaseLocalClaim(postTargetId: string): void {
  const n = (holders.get(postTargetId) ?? 0) - 1;
  if (n > 0) holders.set(postTargetId, n);
  else holders.delete(postTargetId);
}

export function localClaimCount(postTargetId: string): number {
  return holders.get(postTargetId) ?? 0;
}
