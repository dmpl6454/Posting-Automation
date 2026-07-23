/**
 * PR-5 — per-channel unique captions: shared planning helper for the two
 * entry points (post.router `create` and chat.router `publish_now` /
 * `schedule_post`).
 *
 * Decision (locked by the Phase-B audit, docs/PHASE-B-AUDIT-AND-PLAN.md §3):
 * unique captions ride on PostTarget.contentOverride + an ASYNC fanout worker
 * — the post is created as DRAFT (the publish cron only picks SCHEDULED),
 * ONE caption-fanout job is enqueued (jobId `caption-fanout-{postId}`), and
 * the worker flips DRAFT→SCHEDULED when the captions are written (or on
 * failure, degraded — shared caption publishes, the post is never lost).
 *
 * Pure + exported so tests can lock the matrix without a tRPC caller harness.
 */
export function planCaptionFanout(input: {
  uniqueCaptions: boolean;
  channelCount: number;
  scheduledAt: string | Date | null | undefined;
}): { enabled: boolean; pendingSchedule: boolean } {
  // Fanout only makes sense for >1 channel — a single-channel or channel-less
  // post keeps today's shared-caption path byte-identical.
  const enabled = input.uniqueCaptions === true && input.channelCount > 1;
  // Only a post that WOULD have been SCHEDULED needs the worker's
  // DRAFT→SCHEDULED flip; a plain draft just gets its captions written.
  return { enabled, pendingSchedule: enabled && input.scheduledAt != null };
}

/**
 * jobId + job name for the single per-post fanout job (dedupes re-submits).
 *
 * ⚠️ Colon-DELIMITED ids are NOT allowed here. BullMQ >=5.70 throws
 * "Custom Id cannot contain :" for any custom jobId that contains a colon but
 * does not split into EXACTLY 3 segments (see bullmq Job.addJob). The old
 * `caption-fanout:{postId}` (2 segments) broke unique-caption publish outright.
 * Use hyphen delimiters so the id is always colon-free and safe.
 */
export function captionFanoutJobId(postId: string): string {
  return `caption-fanout-${postId}`;
}
