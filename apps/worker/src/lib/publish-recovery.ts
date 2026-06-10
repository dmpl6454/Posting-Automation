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
