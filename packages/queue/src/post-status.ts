/**
 * The parent Post's status, derived from its targets (2026-09-21).
 *
 * Lives in `packages/queue` because THREE places must agree on it: the publish
 * worker's success path, the publish worker's failed-handler, and the watchdog.
 * They previously each open-coded the rule, which is how a fourth state could be
 * added to targets without every finalizer learning about it.
 *
 * ⚠️ A CANCELLED target is EXCLUDED from the verdict. It is neither a success
 * nor a failure — it is a channel the user withdrew before it was dispatched.
 * Counting it either way is wrong in a way the user can see:
 *
 *   - Counted as success: a post whose every channel was cancelled reads
 *     "Published", with no post anywhere.
 *   - Counted as failure: a deliberate cancel is reported as a malfunction, and
 *     the publish email says channels "failed to publish".
 *
 * 🔴 The specific bug this shape prevents: widening an "all done?" check to
 * include CANCELLED while leaving a separate "all failed?" check alone. A post
 * with one FAILED and one CANCELLED target then satisfies "all done" but not
 * "all failed", and is written **PUBLISHED** — announcing a success that never
 * happened. Deriving both answers from one filtered population makes that
 * combination unrepresentable.
 */

/** Statuses a target can no longer move on from without a human acting. */
const TERMINAL = new Set(["PUBLISHED", "FAILED", "CANCELLED"]);

export type PostVerdict =
  /** At least one target can still change — leave the Post row alone. */
  | { settled: false }
  | { settled: true; status: "PUBLISHED" | "FAILED" | "CANCELLED" };

/**
 * ⚠️ Returns `{ settled: false }` for an EMPTY target list. A post with no
 * targets has nothing to conclude from, and writing a terminal status for it
 * would finalize a channel-less draft the user is still editing.
 */
export function resolvePostStatusFromTargets(
  targets: ReadonlyArray<{ status: string }>
): PostVerdict {
  if (targets.length === 0) return { settled: false };
  if (!targets.every((t) => TERMINAL.has(t.status))) return { settled: false };

  // The population the verdict is actually about.
  const live = targets.filter((t) => t.status !== "CANCELLED");

  if (live.length === 0) return { settled: true, status: "CANCELLED" };
  if (live.some((t) => t.status === "PUBLISHED")) return { settled: true, status: "PUBLISHED" };
  return { settled: true, status: "FAILED" };
}

/**
 * Which targets a cancel may touch: queued but not yet dispatched.
 *
 * ⚠️ PUBLISHING is excluded deliberately. A job holds that target and may be
 * mid-upload; the platform will answer, and the worker will write PUBLISHED over
 * anything we set here. Offering to cancel it would be a promise we cannot keep.
 *
 * ⚠️ FAILED is excluded too. It already ran and settled — relabelling it as
 * cancelled would erase the reason it failed. PUBLISHED is obviously excluded:
 * that content is live and nothing can recall it.
 */
export const CANCELLABLE_TARGET_STATUSES = ["SCHEDULED", "DRAFT"] as const;

export function isCancellableStatus(status: string): boolean {
  return (CANCELLABLE_TARGET_STATUSES as readonly string[]).includes(status);
}
