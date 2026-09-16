import { isAmbiguousPublishError } from "@postautomation/social";
// Pure, prisma-injectable helpers for recovering posts stuck in PUBLISHING.
//
// Extracted out of the worker so they can be unit-tested without booting
// BullMQ / Redis. See post-publish.worker.ts (markTargetFailed call sites on the
// token_expired + content_too_large error branches) and auto-healer.worker.ts
// (the stuck-PUBLISHING reaper).

/**
 * The statuses a publish job may claim, i.e. transition to PUBLISHING.
 *
 * ⚠️ FAILED is in this set BY DESIGN: several error branches mark a target FAILED
 * before rethrowing so it cannot be orphaned at PUBLISHING, and the subsequent
 * BullMQ attempt is then meant to pick it back up. The consequence — discovered
 * the hard way on 2026-08-13 — is that a FAILED target is fully re-publishable,
 * so a failure that was actually a SUCCESS gets re-posted once per attempt.
 * `ambiguousAt` (below) is what makes that survivable; do not "fix" this by
 * removing FAILED, which would orphan targets at PUBLISHING again.
 */
export const PUBLISH_CLAIM_STATUSES = ["SCHEDULED", "FAILED", "DRAFT"] as const;

/**
 * The atomic claim's WHERE clause.
 *
 * ⚠️ `ambiguousAt: null` is the load-bearing addition. A target whose publish
 * outcome could not be determined must be unreachable by EVERY retry layer —
 * BullMQ `attempts`, the 30s reconciliation cron, chat/agent publishes, and a
 * human clicking Retry all funnel through this claim. Pre-existing rows all have
 * NULL here, so the predicate is a no-op for them.
 *
 * Named and exported so the guarantee is testable without booting the worker.
 */
export type PublishClaimStatus = (typeof PUBLISH_CLAIM_STATUSES)[number];

export function buildPublishClaimWhere(postTargetId: string): {
  id: string;
  status: { in: PublishClaimStatus[] };
  ambiguousAt: null;
} {
  return {
    id: postTargetId,
    // Spread to a MUTABLE array: Prisma's generated `in` filter is `PostStatus[]`
    // and rejects a readonly tuple.
    status: { in: [...PUBLISH_CLAIM_STATUSES] },
    ambiguousAt: null,
  };
}

/**
 * Park a target whose publish outcome is UNKNOWN.
 *
 * Status stays FAILED so the watchdog, the UI's terminal-state handling and the
 * publish report all behave exactly as they already do; `ambiguousAt` is what
 * removes it from the claim so nothing re-publishes it. The operator clears it
 * from the post detail page once they have checked the account.
 *
 * Bookkeeping failures are swallowed: by the time this runs the platform-side
 * outcome is already whatever it is, and throwing here would hand the job back to
 * BullMQ — which is the re-publish we are preventing.
 */
export async function markTargetAmbiguous(
  prisma: {
    postTarget: {
      update: (args: {
        where: { id: string };
        data: {
          status: "FAILED";
          errorMessage: string;
          ambiguousAt: Date;
          ambiguousReason: string;
        };
      }) => Promise<unknown>;
    };
  },
  postTargetId: string,
  reason: string,
): Promise<void> {
  await prisma.postTarget
    .update({
      where: { id: postTargetId },
      data: {
        status: "FAILED",
        errorMessage: reason,
        ambiguousAt: new Date(),
        ambiguousReason: reason,
      },
    })
    .catch((e: any) =>
      console.error(`[PostPublish] failed to mark target ambiguous:`, e?.message),
    );
}

/**
 * Should the worker ask the platform "is this post already live?" BEFORE it
 * publishes?
 *
 * Only on a retry, and only when the answer is not already free. This closes the
 * gap the `publishedId` short-circuit cannot: a previous attempt that published
 * successfully but whose DB write never landed leaves publishedId NULL, so the
 * short-circuit misses and the retry re-posts.
 */
/**
 * Where an error caught by the publish handler must go.
 *
 * ⚠️ THIS EXISTS BECAUSE ORDER IS LOAD-BEARING, and getting it wrong silently
 * defeats the whole duplicate-post fix.
 *
 * The publish `catch` historically ran `classifyError(err.message)` first. That
 * classifier substring-matches, so "token" + "invalid" ANYWHERE in the message
 * yields `token_expired` — and the token_expired branch refreshes the credential
 * and then CALLS provider.publishPost AGAIN.
 *
 * The dominant reason reconciliation cannot confirm an outcome is a dead Meta
 * token, and that error reads "…listing unavailable (token_invalid) — cannot
 * confirm whether the post published". So an UNKNOWN outcome would have been
 * routed into a branch that re-publishes: precisely the duplicate this fix
 * exists to prevent.
 *
 * Routing therefore happens BEFORE any message classification:
 *   - "ambiguous" ⇒ park the target (ambiguousAt) and stop retrying;
 *   - "terminal"  ⇒ the outcome is already decided; rethrow untouched;
 *   - "classify"  ⇒ ordinary error, use the existing chain unchanged.
 *
 * Ambiguity OUTRANKS terminality: a parked target needs its stamp written, and a
 * bare rethrow would leave ambiguousAt NULL and thus re-claimable.
 */
export type PublishErrorRoute = "ambiguous" | "terminal" | "classify";

export function routePublishError(err: unknown): PublishErrorRoute {
  if (isAmbiguousPublishError(err)) return "ambiguous";
  // Duck-typed for the same reason as isAmbiguousPublishError: BullMQ's
  // UnrecoverableError may be a different module instance here.
  if ((err as { name?: unknown } | null)?.name === "UnrecoverableError") return "terminal";
  return "classify";
}

/**
 * Message classification for the publish worker's catch chain (and its
 * `on("failed")` user-message mapping).
 *
 * Moved here from post-publish.worker.ts on 2026-09-16 so it can be unit-tested
 * without importing the worker module (which opens a Redis connection at load).
 * Every pattern below is unchanged, except the new first line.
 */
export type PublishErrorType =
  | "rate_limit"
  | "token_expired"
  | "permission"
  | "content_too_large"
  | "media_required"
  | "unknown";

export function classifyError(errMsg: string): PublishErrorType {
  const msg = errMsg.toLowerCase();
  // ⚠️ MUST stay first. "Validation failed: …" is OUR OWN pre-publish verdict,
  // never a platform response — yet the base validator's "Too many media
  // attachments. Instagram allows max 10." matched "too many" below, so an
  // 11-image post (2026-09-16) was reported as "Platform rate limit hit. Will
  // retry automatically." for a post that can never publish as it stands.
  if (msg.trimStart().startsWith("validation failed")) return "unknown";
  if (msg.includes("limit how often") || msg.includes("rate limit") || msg.includes("too many") || msg.includes("code\":368") || msg.includes("code\":32")) return "rate_limit";
  if (msg.includes("token") && (msg.includes("expired") || msg.includes("invalid")) || msg.includes("code\":190") || msg.includes("401")) return "token_expired";
  if (msg.includes("permission") || msg.includes("code\":10") || msg.includes("403")) return "permission";
  if (msg.includes("reduce the amount") || msg.includes("too long") || msg.includes("too large") || msg.includes("content is too")) return "content_too_large";
  if (msg.includes("requires at least one image") || msg.includes("media required")) return "media_required";
  return "unknown";
}

/**
 * Is this a DEFINITE authentication failure — the credential is dead, and
 * retrying the job cannot help until the user reconnects the channel?
 *
 * WHY (2026-09-16). A dead Instagram token (Graph 190/460, "session has been
 * invalidated") failed attempt 1, the forced token refresh failed the same way,
 * and the worker threw a PLAIN Error — so BullMQ retried. The retry's duplicate
 * pre-flight then tried to LIST the account with that same dead token, could
 * not, and parked the target as "may already have gone live": a false
 * ambiguity, measured on 73 targets since 2026-09-14. Nothing had been
 * published, and the operator was sent to check for a post that never existed.
 *
 * ⚠️ Deliberately NARROW and asymmetric. A positive auth marker is required AND
 * any hint of a network/timeout/5xx problem vetoes it: those can be transient,
 * and calling a transient failure "definite" would stop a retry that might have
 * succeeded. Calling a definite failure "not definite" only costs the old
 * behaviour, so every doubt resolves to false.
 */
//
// ⚠️ A bare "OAuthException" is NOT evidence: Meta stamps that type on nearly
// every Graph error, including transient ones (code 1/2 with is_transient) and
// rate limits (#4/#17/#32) — a refresh that failed that way must stay
// retryable (adversarial review, 2026-09-16). Only credential-specific signals
// count, and Meta's own transience markers veto them.
const DEFINITE_AUTH_FAILURE_RE =
  /invalid_grant|"code"\s*:\s*(?:190|102|463|467)\b|session has been invalidated|Error validating access token|has been revoked|unauthorized_client|invalid_client|invalid_token/i;
const TRANSIENT_FAILURE_RE =
  /fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|aborted|timed? ?out|\b5\d\d\b|"is_transient"\s*:\s*true|"code"\s*:\s*(?:1|2|4|17|32|341|613|80001|80002)\b|retry your request later|request limit/i;

export function isDefiniteAuthFailure(message: string | null | undefined): boolean {
  if (!message) return false;
  return DEFINITE_AUTH_FAILURE_RE.test(message) && !TRANSIENT_FAILURE_RE.test(message);
}

/**
 * Per-job progress flags shared between the publish processor and its wrapper
 * (post-publish.worker.ts, 2026-09-16).
 *
 *   claimed    — this job moved the target to PUBLISHING (atomic claim won).
 *   dispatched — the job reached the publish `try` (pre-flight reconciliation /
 *                first provider.publishPost). From here on, the platform may
 *                hold the post, so ONLY the publish catch branches may write a
 *                terminal state.
 */
export interface PublishJobState {
  claimed: boolean;
  dispatched: boolean;
}

/** errorMessage is TEXT, but a runaway provider message has no business in a UI toast. */
const RELEASE_MESSAGE_MAX_CHARS = 1000;

/**
 * Release a claim whose job threw BEFORE anything was sent to the platform.
 *
 * WHY (2026-09-16). A post with 11 images (Instagram allows 10) threw
 * "Validation failed" AFTER the atomic claim and BEFORE the publish `try`, so
 * nothing ever wrote a terminal state: all 60 targets sat at PUBLISHING for
 * 30-56 minutes. The BullMQ retry then lost the claim (the target was
 * PUBLISHING) and completed silently as a "duplicate".
 *
 * FAILED is the right resting place here: nothing reached the platform, so the
 * target must stay re-claimable, and BullMQ's normal retry takes over —
 * together with the duplicate pre-flight, which runs because the target now
 * carries an errorMessage and worker.on("failed") increments retryCount.
 *
 * ⚠️ CONDITIONAL on status PUBLISHING: a site that already wrote its own
 * terminal state (markTargetFailed with an actionable reason, a SCHEDULED
 * defer) keeps it. NEVER THROWS — the caller rethrows the ORIGINAL error, and a
 * bookkeeping failure must not replace it.
 */
export async function releaseClaimAfterPrePublishError(
  prisma: {
    postTarget: {
      updateMany: (args: {
        where: { id: string; status: "PUBLISHING" };
        data: { status: "FAILED"; errorMessage: string };
      }) => Promise<{ count: number }>;
    };
  },
  postTargetId: string,
  err: unknown,
): Promise<void> {
  const raw =
    (err as { message?: unknown } | null)?.message ?? (err == null ? "" : String(err));
  const message =
    (typeof raw === "string" ? raw : String(raw)).trim().slice(0, RELEASE_MESSAGE_MAX_CHARS) ||
    "Publishing failed before anything was sent to the platform — please retry.";
  try {
    const res = await prisma.postTarget.updateMany({
      where: { id: postTargetId, status: "PUBLISHING" },
      data: { status: "FAILED", errorMessage: message },
    });
    if (res.count > 0) {
      console.warn(
        `[PostPublish] target ${postTargetId} released PUBLISHING → FAILED after a pre-publish error (nothing was sent): ${message}`,
      );
    }
  } catch (e: any) {
    console.error(`[PostPublish] failed to release claim for ${postTargetId}:`, e?.message);
  }
}

/**
 * Written to a target whose claim was left behind by a job that is no longer
 * running (deploy SIGKILL, crash, or an unreleased pre-publish throw).
 *
 * ⚠️ Must classify as "unknown" (locked by a test) so worker.on("failed")
 * keeps it verbatim instead of swapping in "rate limit"/"reconnect" copy.
 */
export const ORPHANED_CLAIM_MESSAGE =
  "A previous publish attempt was interrupted before it finished; retrying after first checking whether it already went live.";

/**
 * Written when a dead holder's publish outcome is unknown AND the platform
 * offers no "is it already live?" check (everything except Instagram and
 * Facebook). Parked as ambiguous: re-publishing automatically could post it
 * twice, so a person checks first (2026-09-16 adversarial review).
 */
export const ORPHANED_CLAIM_UNKNOWN_OUTCOME_MESSAGE =
  "Publishing was interrupted before it finished, and this platform cannot tell us whether the post went live. Nothing was re-sent. Check the account, then use \"It didn't publish\" to try again.";

/**
 * Final-attempt orphan on a platform that CAN be checked (Instagram/Facebook):
 * terminal but retryable, and the next human Retry runs the duplicate
 * pre-flight because worker.on("failed") increments retryCount.
 */
export const FINAL_ATTEMPT_ORPHAN_MESSAGE = "Publishing did not complete after all retries — please retry.";

export type ClaimMissDecision = "terminalize" | "recover-orphan" | "park-orphan" | "skip";

/**
 * What to do when the atomic claim matched nothing (claim.count === 0).
 *
 *   "skip"           — nothing to do: the target is not PUBLISHING, it already
 *                      has a platform id, another job holds it, or (non-final
 *                      attempt) the holder check could not run.
 *   "recover-orphan" — NON-final attempt, the target is PUBLISHING, NO job
 *                      holds it, and the platform CAN tell us whether the dead
 *                      holder already published (Instagram / Facebook
 *                      findExistingPost; IG/FB stories via their checkpoint).
 *                      The worker releases it and fails this attempt, and the
 *                      retry runs that duplicate check before any re-publish.
 *   "park-orphan"    — same, but the platform has NO such check. The dead
 *                      holder may have published, so an automatic retry could
 *                      post it twice: park it as ambiguous for a person.
 *   "terminalize"    — FINAL attempt on an unheld orphan whose platform can be
 *                      checked (the next human Retry runs the check), or the
 *                      final attempt when the holder check itself failed (the
 *                      pre-2026-09-16 behaviour, kept for that case only).
 *
 * `otherActiveJobs` is null when the holder check was not (or could not be)
 * performed. ⚠️ Recovery needs POSITIVE evidence that nobody holds the claim:
 * releasing a live claim invites a concurrent publish. The final attempt also
 * honours a live holder now — terminalizing a target another job is still
 * publishing made it re-claimable mid-publish (adversarial review).
 */
export function decideClaimMiss(opts: {
  isFinalAttempt: boolean;
  status: string | null;
  hasPublishedId: boolean;
  otherActiveJobs: number | null;
  providerSupportsReconcile: boolean;
}): ClaimMissDecision {
  if (opts.status !== "PUBLISHING" || opts.hasPublishedId) return "skip";
  if (opts.otherActiveJobs === null) {
    return terminalizeStuckClaim({ claimCount: 0, isFinalAttempt: opts.isFinalAttempt }) ? "terminalize" : "skip";
  }
  if (opts.otherActiveJobs > 0) return "skip";
  if (!opts.providerSupportsReconcile) return "park-orphan";
  return opts.isFinalAttempt ? "terminalize" : "recover-orphan";
}

export type ReapDecision = "skip" | "fail-retryable" | "park";

/**
 * The stuck-PUBLISHING reaper's per-target rule (2026-09-16). Same evidence
 * standard as decideClaimMiss: a target that a running job still holds is
 * never reaped (a slow, live publish would otherwise be made re-claimable and
 * published twice on the next Retry). An unheld target's outcome is unknown,
 * so platforms without a duplicate check are parked for a person.
 */
export function decideReap(opts: { heldByActiveJob: boolean; providerSupportsReconcile: boolean }): ReapDecision {
  if (opts.heldByActiveJob) return "skip";
  return opts.providerSupportsReconcile ? "fail-retryable" : "park";
}

/**
 * How many OTHER jobs are working on this target, counted from BullMQ's active
 * list (all workers, Redis-wide) plus this process's own in-flight claims.
 *
 * The local count matters: if a job's lock lapses, BullMQ's stalled checker can
 * re-run the SAME job id while the first run is still publishing. Filtering the
 * active list by job id hides that first run, so the process-local registry is
 * what keeps it from being mistaken for an orphan.
 *
 * `activeJobs` entries may be undefined (Job.fromId returns undefined for a job
 * removed between the range read and the hash read).
 */
export function countOtherActiveJobsForTarget(
  activeJobs: ReadonlyArray<{ id?: string | null; data?: { postTargetId?: unknown } | null } | null | undefined>,
  selfJobId: string | null | undefined,
  postTargetId: string,
  localHolders = 0,
): number {
  let n = 0;
  for (const j of activeJobs) {
    if (!j) continue;
    if (selfJobId != null && j.id === selfJobId) continue;
    if (j.data?.postTargetId === postTargetId) n++;
  }
  return n + Math.max(0, localHolders);
}

/**
 * One grep-able line per successful publish (2026-09-16) so queue wait and run
 * time can be measured from logs instead of inferred. Fields whose inputs are
 * missing are OMITTED rather than printed as NaN.
 *
 *   queueWaitMs    — processedOn − (timestamp + delay): time ready-but-waiting.
 *   runMs          — now − processedOn: this attempt's processing time.
 *   sinceEnqueueMs — now − timestamp: end-to-end, including any delay/stagger.
 */
export function formatPublishTiming(opts: {
  postTargetId: string;
  platform: string;
  timestamp?: number | null;
  processedOn?: number | null;
  delay?: number | null;
  now: number;
}): string {
  const parts = [`[PublishTiming] target=${opts.postTargetId} platform=${opts.platform}`];
  const { timestamp, processedOn } = opts;
  const hasTs = typeof timestamp === "number" && Number.isFinite(timestamp);
  const hasProc = typeof processedOn === "number" && Number.isFinite(processedOn);
  if (hasTs && hasProc) parts.push(`queueWaitMs=${processedOn - (timestamp + (opts.delay || 0))}`);
  if (hasProc) parts.push(`runMs=${opts.now - processedOn}`);
  if (hasTs) parts.push(`sinceEnqueueMs=${opts.now - timestamp}`);
  return parts.join(" ");
}

export function shouldPreflightReconcile(opts: {
  /** BullMQ attempt counter — per JOB, so it resets on every new job. */
  attemptsMade: number;
  /**
   * Has THIS TARGET been attempted before, across jobs?
   *
   * ⚠️ REQUIRED, and the reason this function is not just `attemptsMade > 0`.
   * `attemptsMade` is per-job, and four producers mint a BRAND-NEW job for the
   * same target: post.publishNow (a new 60s bucket is a new job), the worker's
   * own rate-limit re-queue, the heavy-slot defer, and the optimize-wait defer.
   * On every one of those the counter is 0 — so keying on it alone means the
   * pre-flight never runs on the human-Retry path it exists to protect, which is
   * exactly the path that produced the 2026-08-13 duplicates.
   *
   * `PostTarget.retryCount` is incremented by worker.on("failed") and therefore
   * survives across jobs, which makes it the durable signal.
   */
  targetAttemptedBefore: boolean;
  hasPublishedId: boolean;
  providerSupportsReconcile: boolean;
}): boolean {
  if (!opts.providerSupportsReconcile) return false;
  // publishedId already answers the question for free.
  if (opts.hasPublishedId) return false;
  return opts.attemptsMade > 0 || opts.targetAttemptedBefore;
}

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
 *
 * ⚠️ A STORY gets its own copy. The worker deliberately skips AI auto-generation
 * for STORY targets (a story is the user's own media), so "enable AI image
 * generation" is a remedy that can never work there. The non-story string is
 * unchanged byte for byte.
 */
export function mediaRequiredReason(platform: string, opts: { isStory?: boolean } = {}): string {
  const label = MEDIA_REQUIRED_LABEL[platform] ?? platform;
  if (opts.isStory) {
    return `This ${label} story has no image or video attached. Attach an image or video to the post and retry.`;
  }
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
