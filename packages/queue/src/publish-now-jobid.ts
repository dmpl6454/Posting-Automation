/**
 * Deterministic jobId for interactive publishes (`post.publishNow` — the Retry
 * and "Publish Now" buttons).
 *
 * ⚠️ WHY THIS EXISTS. `publishNow` passed no jobId, so BullMQ minted a fresh
 * auto-increment id per call and identical clicks could never deduplicate.
 * Confirmed in production Redis on 2026-08-13: the same target was enqueued as
 * jobs 1576349 and 1576351 from two Retry clicks 81 seconds apart, each with
 * `attempts: 3` — six potential writes of a NON-IDEMPOTENT create.
 *
 * A time bucket rather than a bare target id, because a deliberate retry minutes
 * later is legitimate and must still reach the queue; only the burst of clicks
 * that produced the incident collapses.
 *
 * ⚠️ Bucketing is a *convenience*, not the safety mechanism. The guarantee that a
 * duplicate job cannot duplicate a POST comes from the worker's atomic claim plus
 * `PostTarget.ambiguousAt`. Do not weaken either on the strength of this id.
 */

/** Clicks landing in the same window share an id. */
export const PUBLISH_NOW_DEDUPE_WINDOW_MS = 60_000;

/**
 * `pubnow:{targetId}:{bucket}` — EXACTLY three colon-separated segments, the same
 * constraint BullMQ imposes on the `sched:` / `atage:` / `avatar:` ids.
 */
export function buildPublishNowJobId(postTargetId: string, nowMs: number): string {
  const bucket = Math.floor(nowMs / PUBLISH_NOW_DEDUPE_WINDOW_MS);
  return `pubnow:${postTargetId}:${bucket}`;
}
