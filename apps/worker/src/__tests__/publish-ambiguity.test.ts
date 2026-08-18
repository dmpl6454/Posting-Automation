import { describe, it, expect, vi } from "vitest";
import {
  PUBLISH_CLAIM_STATUSES,
  buildPublishClaimWhere,
  markTargetAmbiguous,
  routePublishError,
  shouldPreflightReconcile,
} from "../lib/publish-recovery";

/**
 * The publish worker's claim was described in code as an "atomic idempotency
 * claim". It is not one. It is a MUTUAL-EXCLUSION guard: it stops two jobs
 * publishing at the same moment, and does nothing at all about publishing again a
 * minute later — because FAILED is inside its own allowed transition set.
 *
 * That is how the 2026-08-13 incident worked. The `else` branch wrote
 * status: FAILED and rethrew (deliberately, to avoid orphaning the target at
 * PUBLISHING), BullMQ's `attempts: 3` then found a claimable target and re-ran a
 * non-idempotent create. Measured: 11 of 11 "failed" Instagram targets were live,
 * one account got 5 copies.
 *
 * `ambiguousAt` is the missing piece — a terminal, non-reclaimable resting place.
 */
describe("buildPublishClaimWhere", () => {
  it("still claims exactly the three historical statuses", () => {
    // Widening or narrowing this set changes which targets a retry may publish.
    expect(PUBLISH_CLAIM_STATUSES).toEqual(["SCHEDULED", "FAILED", "DRAFT"]);
    expect(buildPublishClaimWhere("t1").status).toEqual({ in: ["SCHEDULED", "FAILED", "DRAFT"] });
  });

  it("refuses to claim a target whose outcome is unknown", () => {
    // The single most important assertion in this file: without `ambiguousAt: null`
    // every retry layer can re-publish a post that may already be live.
    expect(buildPublishClaimWhere("t1")).toEqual({
      id: "t1",
      status: { in: ["SCHEDULED", "FAILED", "DRAFT"] },
      ambiguousAt: null,
    });
  });

  it("is byte-compatible with pre-existing rows", () => {
    // Every historical PostTarget has ambiguousAt NULL, so the added predicate
    // matches them exactly as before — the change cannot strand existing work.
    const where = buildPublishClaimWhere("t1");
    expect(where.ambiguousAt).toBeNull();
  });
});

describe("markTargetAmbiguous", () => {
  it("parks the target terminally: FAILED status plus the non-reclaimable stamp", async () => {
    const update = vi.fn(async (_args: any) => ({}) as any);
    await markTargetAmbiguous({ postTarget: { update } } as any, "t1", "may already be live");

    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0]![0] as any;
    expect(arg.where).toEqual({ id: "t1" });
    // FAILED keeps the existing UI/watchdog semantics (terminal, not spinning);
    // ambiguousAt is what removes it from the claim.
    expect(arg.data.status).toBe("FAILED");
    expect(arg.data.errorMessage).toBe("may already be live");
    expect(arg.data.ambiguousReason).toBe("may already be live");
    expect(arg.data.ambiguousAt).toBeInstanceOf(Date);
  });

  it("never lets a bookkeeping failure escape — the platform state is already decided", async () => {
    const update = vi.fn(async (_args: any) => {
      throw new Error("db down");
    });
    await expect(
      markTargetAmbiguous({ postTarget: { update } } as any, "t1", "reason")
    ).resolves.toBeUndefined();
  });
});

describe("shouldPreflightReconcile", () => {
  const base = {
    attemptsMade: 0,
    targetAttemptedBefore: false,
    hasPublishedId: false,
    providerSupportsReconcile: true,
  };

  it("does not spend a Graph call on a genuine first attempt", () => {
    expect(shouldPreflightReconcile(base)).toBe(false);
  });

  it("checks before re-publishing on a BullMQ retry of the same job", () => {
    expect(shouldPreflightReconcile({ ...base, attemptsMade: 1 })).toBe(true);
    expect(shouldPreflightReconcile({ ...base, attemptsMade: 7 })).toBe(true);
  });

  it("checks on a BRAND-NEW job for a target that was already attempted", () => {
    // Review finding, and the important one: `attemptsMade` is per-JOB and resets
    // to 0 for every human Retry click and every internal re-queue. Keying on it
    // alone meant the pre-flight never ran on the human-Retry path — the exact
    // path that produced the 2026-08-13 duplicates. PostTarget.retryCount is
    // incremented by worker.on("failed") and so survives across jobs.
    expect(shouldPreflightReconcile({ ...base, attemptsMade: 0, targetAttemptedBefore: true })).toBe(
      true
    );
  });

  it("skips when publishedId already answers the question for free", () => {
    expect(
      shouldPreflightReconcile({ ...base, attemptsMade: 2, targetAttemptedBefore: true, hasPublishedId: true })
    ).toBe(false);
  });

  it("skips for providers with no reconciliation capability — their behaviour is unchanged", () => {
    expect(
      shouldPreflightReconcile({
        ...base,
        attemptsMade: 2,
        targetAttemptedBefore: true,
        providerSupportsReconcile: false,
      })
    ).toBe(false);
  });
});

describe("routePublishError — ORDERING is the whole point", () => {
  /**
   * A defect found during review of this very fix, and the reason this function
   * exists at all rather than an if/else chain inside the worker.
   *
   * The publish `catch` runs `classifyError(err.message)` FIRST. That classifier
   * substring-matches, so `"token"` + `"invalid"` anywhere in the message yields
   * `token_expired` — and the token_expired branch refreshes the credential and
   * then CALLS provider.publishPost AGAIN.
   *
   * The dominant reason reconciliation cannot confirm an outcome is a dead Meta
   * token, and that error reads:
   *   "Instagram listing unavailable (token_invalid) — cannot confirm whether the post published"
   *
   * So without routing FIRST, the exact scenario this fix exists to prevent —
   * an unknown outcome — would be routed into a code path that re-publishes.
   * The ambiguity/terminal decision MUST precede classification.
   */
  const AMBIGUOUS_WITH_TOKEN_WORDS = Object.assign(new Error(
    "A previous attempt to publish this may already have gone live, and INSTAGRAM could not " +
      "confirm either way. (Instagram listing unavailable (token_invalid) — cannot confirm " +
      "whether the post published)"
  ), { isAmbiguousPublish: true as const });

  it("routes an ambiguous error to parking even when it mentions an invalid token", () => {
    expect(routePublishError(AMBIGUOUS_WITH_TOKEN_WORDS)).toBe("ambiguous");
  });

  it("routes an already-terminal error straight through, never to classification", () => {
    // The pre-flight throws UnrecoverableError from INSIDE the publish try, so the
    // catch sees it. Re-classifying it could route a parked target back into a
    // re-publishing branch.
    const unrecoverable = Object.assign(new Error("parked: may already be live (token_invalid)"), {
      name: "UnrecoverableError",
    });
    expect(routePublishError(unrecoverable)).toBe("terminal");
  });

  it("leaves every ordinary error to the existing classification chain", () => {
    for (const m of [
      'Instagram publish failed: {"error":{"code":190,"message":"Error validating access token"}}',
      "Facebook rate limit reached",
      "Validation failed: missing media",
      "boom",
    ]) {
      expect(routePublishError(new Error(m)), m).toBe("classify");
    }
  });

  it("ambiguity outranks terminality — the target still needs parking", () => {
    // An AmbiguousPublishError that is ALSO named UnrecoverableError must still
    // reach the parking branch, or it would be rethrown without ambiguousAt set
    // and the next retry could re-publish it.
    const both = Object.assign(new Error("unknown outcome"), {
      isAmbiguousPublish: true as const,
      name: "UnrecoverableError",
    });
    expect(routePublishError(both)).toBe("ambiguous");
  });
});
