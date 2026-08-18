import { describe, it, expect, vi } from "vitest";
import {
  PUBLISH_CLAIM_STATUSES,
  buildPublishClaimWhere,
  markTargetAmbiguous,
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
  const base = { attemptsMade: 0, hasPublishedId: false, providerSupportsReconcile: true };

  it("does not spend a Graph call on a first attempt", () => {
    expect(shouldPreflightReconcile(base)).toBe(false);
  });

  it("checks before re-publishing on any retry", () => {
    // This is the safety net for the case the publishedId short-circuit cannot
    // cover: a previous attempt published but its DB write never landed.
    expect(shouldPreflightReconcile({ ...base, attemptsMade: 1 })).toBe(true);
    expect(shouldPreflightReconcile({ ...base, attemptsMade: 7 })).toBe(true);
  });

  it("skips when publishedId already answers the question for free", () => {
    expect(shouldPreflightReconcile({ ...base, attemptsMade: 2, hasPublishedId: true })).toBe(false);
  });

  it("skips for providers with no reconciliation capability — their behaviour is unchanged", () => {
    expect(
      shouldPreflightReconcile({ ...base, attemptsMade: 2, providerSupportsReconcile: false })
    ).toBe(false);
  });
});
