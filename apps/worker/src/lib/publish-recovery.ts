// Pure, prisma-injectable helpers for recovering posts stuck in PUBLISHING.
//
// Extracted out of the worker so they can be unit-tested without booting
// BullMQ / Redis. See post-publish.worker.ts (markTargetFailed call sites on the
// token_expired + content_too_large error branches) and auto-healer.worker.ts
// (the stuck-PUBLISHING reaper).

/**
 * Idempotently mark a PostTarget as FAILED with an error message.
 *
 * Mirrors EXACTLY how the generic unknown-error branch in post-publish.worker.ts
 * writes FAILED: same field names (`status`/`errorMessage`), no truncation, and
 * the same swallowed-promise behavior so a DB hiccup here never masks the real
 * publish error that is about to be re-thrown. `prisma` is a parameter so callers
 * (and tests) can inject a real or mock client.
 */
export async function markTargetFailed(
  prisma: {
    postTarget: {
      update: (args: {
        where: { id: string };
        data: { status: "FAILED"; errorMessage: string };
      }) => Promise<unknown>;
    };
  },
  postTargetId: string,
  message: string,
): Promise<void> {
  await prisma.postTarget
    .update({
      where: { id: postTargetId },
      data: { status: "FAILED", errorMessage: message },
    })
    .catch((e: any) =>
      console.error(`[PostPublish] failed to mark target FAILED:`, e?.message),
    );
}

/**
 * Shape of a single `prisma.notification.create({ data })` payload, matching the
 * Notification Prisma model EXACTLY (`type`/`title`/`body`/`link`/`metadata`).
 */
export interface NotificationCreateData {
  userId: string;
  organizationId: string;
  type: "post.published" | "post.failed";
  title: string;
  body: string;
  link: string;
  metadata: { postId: string; postTargetId: string; platform: string };
}

/**
 * Pure helper: build one in-app Notification payload per org owner/admin for a
 * publish outcome. The worker maps each returned object straight into
 * `prisma.notification.create({ data })`. Extracted so it's unit-testable
 * without BullMQ/Redis/Prisma.
 *
 * Best-effort by design at the call site — the worker wraps the create loop in a
 * try/catch so a notification failure can NEVER fail the publish.
 */
export function buildPublishNotifications(
  memberUserIds: string[],
  opts: {
    organizationId: string;
    postId: string;
    postTargetId: string;
    platform: string;
    status: "PUBLISHED" | "FAILED";
  },
): NotificationCreateData[] {
  const published = opts.status === "PUBLISHED";
  const type = published ? "post.published" : "post.failed";
  const title = published ? "Post published" : "Post failed";
  const body = published
    ? `Published to ${opts.platform}`
    : `Failed to publish to ${opts.platform}`;
  const link = `/dashboard/posts/${opts.postId}`;

  return memberUserIds.map((userId) => ({
    userId,
    organizationId: opts.organizationId,
    type,
    title,
    body,
    link,
    metadata: {
      postId: opts.postId,
      postTargetId: opts.postTargetId,
      platform: opts.platform,
    },
  }));
}

/**
 * Pure predicate: should the auto-healer reap this target?
 *
 * A PostTarget that has sat in PUBLISHING for longer than `maxAgeMs` is
 * orphaned (the publishing job already finished/skipped) and must be set to
 * FAILED — NOT re-queued, because the worker's claim guard only transitions
 * SCHEDULED/FAILED/DRAFT → PUBLISHING, so a re-queued job on a PUBLISHING
 * target is silently skipped (claim.count === 0) and never rescues anything.
 */
export function shouldReapPublishing(
  target: { status: string; updatedAt: Date },
  now: Date,
  maxAgeMs = 30 * 60 * 1000,
): boolean {
  return (
    target.status === "PUBLISHING" &&
    now.getTime() - target.updatedAt.getTime() > maxAgeMs
  );
}

const MEDIA_REQUIRED_LABEL: Record<string, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
};

/**
 * Human-readable FAILED reason for a post that hit the media-required wall in the
 * worker (no media attached and AI auto-generation didn't produce an image).
 * Used by the worker's `media_required` error branch.
 */
export function mediaRequiredReason(platform: string): string {
  const label = MEDIA_REQUIRED_LABEL[platform] ?? platform;
  return `${label} requires an image or video; none was attached and AI generation is off or unavailable. Attach media (or enable AI image generation) and retry.`;
}

/**
 * Pure decision: should the worker FORCE a stuck PUBLISHING target to FAILED?
 *
 * The atomic claim guard only transitions SCHEDULED/FAILED/DRAFT → PUBLISHING. A
 * BullMQ retry on a target that is ALREADY PUBLISHING gets claimCount === 0 and
 * the worker returns early — but on the FINAL attempt that early return would
 * leave the target orphaned at PUBLISHING forever (the watchdog only reaps after
 * 30 min). So on the final attempt with a no-op claim we must terminalize it now.
 */
export function terminalizeStuckClaim(opts: {
  claimCount: number;
  isFinalAttempt: boolean;
}): boolean {
  return opts.claimCount === 0 && opts.isFinalAttempt;
}

/**
 * True when a publish-job failure belongs to demo SEED data (`pnpm db:seed`
 * creates posts `seed-post-001..00N` on demo channels with fake
 * `demo-access-token-*` credentials). Those always 401 → token_expired noise
 * that pollutes Monitoring with non-bugs. The publish worker uses this to SKIP
 * the ErrorLog write for seed failures. Real posts use cuid ids and never carry
 * the `seed-post-` prefix, so this can't false-positive on production failures.
 */
export function isSeedNoise(jobData: { postId?: string }): boolean {
  return typeof jobData.postId === "string" && jobData.postId.startsWith("seed-post-");
}

/**
 * Phase 2 exact-time guard: is this schedule-path job STALE?
 *
 * Creation-time delayed jobs carry `enqueuedFor` = the post's scheduledAt
 * (epoch ms) as of enqueue. A SCHEDULED post can be rescheduled WITHOUT its
 * targets being recreated (post.update keeps target ids when only the date
 * changes), so the old-time job still exists and would otherwise publish at
 * the OLD time. The publish worker calls this BEFORE the atomic claim and
 * skips silently when it returns true — the reschedule minted fresh jobs
 * under the new epoch, and unschedule/publishNow paths reset scheduledAt so
 * the mismatch catches those too.
 *
 * `scheduledAt` is the post's CURRENT value (null when the post is gone or
 * unscheduled → always stale). Tolerance covers ms-truncation only — the
 * enqueue snapshot and the stored column come from the same Date value, so
 * exact equality is the expected match.
 */
export function isStaleScheduleJob(
  enqueuedFor: number,
  scheduledAt: Date | null | undefined,
  toleranceMs = 1_000
): boolean {
  if (!scheduledAt) return true;
  return Math.abs(scheduledAt.getTime() - enqueuedFor) > toleranceMs;
}

/**
 * Heavy-upload lane (scenario batch 2026-07-20). Streamed publishes
 * (YouTube/X/LinkedIn) hold a worker slot for their entire chunk loop, so
 * only HEAVY_MEDIA_CONCURRENCY may run at once; the excess is DEFERRED via
 * the rate-limit re-queue pattern. This message is written to the deferred
 * target's errorMessage AND matched by the watchdog's keep-alive check —
 * shared constant so the two sites can never drift.
 */
export const HEAVY_SLOT_WAIT_MESSAGE = "Waiting for a large-upload slot";
// Parked while media-optimize produces the platform rendition (IG/FB >1GB).
export const OPTIMIZE_WAIT_MESSAGE = "Optimizing video for this platform";

/** Is this publish "heavy" — a streamed platform with media above the threshold? */
export function isHeavyPublish(
  platform: string,
  totalMediaBytes: number,
  thresholdBytes: number,
  heavyPlatforms: ReadonlySet<string>
): boolean {
  return heavyPlatforms.has(platform) && totalMediaBytes > thresholdBytes;
}

/**
 * Gate decision (pure): null → proceed; otherwise the jittered defer delay.
 * 45–90s jitter so N deferred jobs never thunder back in lockstep.
 */
export function planHeavyDefer(opts: {
  isHeavy: boolean;
  active: number;
  cap: number;
  rand?: () => number;
}): { delayMs: number } | null {
  if (!opts.isHeavy || opts.active < opts.cap) return null;
  const rand = opts.rand ?? Math.random;
  return { delayMs: 45_000 + Math.floor(rand() * 45_000) };
}
