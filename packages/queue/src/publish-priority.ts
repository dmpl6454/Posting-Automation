/**
 * Publish-queue priority lanes.
 *
 * BullMQ semantics (verified against bullmq@5.x moveToActive.lua): jobs added
 * WITHOUT a priority live in the plain wait list, which workers drain BEFORE
 * the prioritized set. Interactive publishes (post.router publishNow,
 * chat.router publish_now, newsgrid bulkPublish) therefore deliberately set NO
 * priority — a user who clicked "Publish now" always jumps ahead of background
 * work. Do NOT "fix" those producers by adding a priority; that would demote
 * them behind nothing and slow their enqueue path (prioritized inserts are
 * O(log n)).
 *
 * Background producers set these explicit lanes (lower number = sooner):
 */

/** Cron-discovered scheduled posts and autopilot publishes. */
export const PRIORITY_BULK = 5;

/** Rate-limit retry re-enqueues — always yield to fresh work. */
export const PRIORITY_RETRY = 10;
