import { postPublishQueue } from "./queues";
import { computePublishDelays } from "./publish-stagger";
import { PRIORITY_BULK } from "./publish-priority";
import type { PostPublishJobData } from "./types";

/**
 * Phase 2 exact-time scheduling — one delayed publish job per target with a
 * DETERMINISTIC jobId, enqueued from BOTH the creation path (post.create /
 * post.update, at save time) and the 30s reconciliation cron (at due time).
 * BullMQ dedupes on jobId while a job is delayed/waiting/active, so the two
 * producers can overlap freely: whoever runs first wins, the other is a no-op.
 *
 * jobId shape: `sched:{targetId}:{scheduledAtEpochMs}` — EXACTLY three
 * colon-separated segments (BullMQ rejects other colon counts in custom ids;
 * same constraint as the `atage:` / `avatar:` ids). The epoch in the id means
 * a RESCHEDULE naturally mints new ids; the orphaned old-time jobs are
 * neutralized by the worker's `isStaleScheduleJob` guard, which compares the
 * post's CURRENT scheduledAt against the `enqueuedFor` snapshot carried in
 * the job data.
 */

export interface SchedulablePublishTarget {
  id: string;
  channelId: string;
  platform: string;
}

export interface ScheduledPublishArgs {
  postId: string;
  organizationId: string;
  scheduledAt: Date;
  targets: SchedulablePublishTarget[];
  /** Injectable clock for tests. */
  now?: number;
}

export interface ScheduledPublishJobSpec {
  name: string;
  data: PostPublishJobData;
  opts: {
    jobId: string;
    delay: number;
    priority: number;
    attempts: number;
    backoff: { type: "exponential"; delay: number };
    removeOnComplete: true;
    removeOnFail: number;
  };
}

/** Pure job-spec builder — all the id/delay/priority math, no I/O. */
export function buildScheduledPublishJobs(args: ScheduledPublishArgs): ScheduledPublishJobSpec[] {
  const now = args.now ?? Date.now();
  const scheduledEpoch = args.scheduledAt.getTime();
  const baseDelay = Math.max(0, scheduledEpoch - now);
  const staggers = computePublishDelays(args.targets);

  return args.targets.map((target, i) => ({
    name: `sched-publish-${args.postId}-${target.channelId}`,
    data: {
      postId: args.postId,
      postTargetId: target.id,
      channelId: target.channelId,
      platform: target.platform,
      organizationId: args.organizationId,
      enqueuedFor: scheduledEpoch,
    },
    opts: {
      jobId: `sched:${target.id}:${scheduledEpoch}`,
      delay: baseDelay + staggers[i]!,
      priority: PRIORITY_BULK,
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: true,
      removeOnFail: 100,
    },
  }));
}

/**
 * Enqueue the delayed publish jobs (idempotent via the deterministic jobIds).
 * Throws on Redis errors — request-path callers (post.create / post.update)
 * MUST wrap in try/catch and treat failure as non-fatal: the 30s cron re-adds
 * the same ids at due time, so a blip here only costs exactness, never the
 * post.
 */
export async function enqueueScheduledPublishJobs(args: ScheduledPublishArgs): Promise<number> {
  const jobs = buildScheduledPublishJobs(args);
  for (const job of jobs) {
    await postPublishQueue.add(job.name, job.data, job.opts);
  }
  return jobs.length;
}
