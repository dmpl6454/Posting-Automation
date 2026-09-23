import { describe, it, expect } from "vitest";
import {
  resolvePostStatusFromTargets,
  isCancellableStatus,
  CANCELLABLE_TARGET_STATUSES,
} from "../post-status";

const t = (status: string) => ({ status });

describe("resolvePostStatusFromTargets", () => {
  it("is unsettled while ANY target can still change", () => {
    expect(resolvePostStatusFromTargets([t("PUBLISHED"), t("SCHEDULED")])).toEqual({ settled: false });
    expect(resolvePostStatusFromTargets([t("PUBLISHING")])).toEqual({ settled: false });
    expect(resolvePostStatusFromTargets([t("DRAFT"), t("CANCELLED")])).toEqual({ settled: false });
  });

  it("is unsettled for an EMPTY target list", () => {
    // A channel-less draft has nothing to conclude from; finalizing it would
    // terminate a post the user is still editing.
    expect(resolvePostStatusFromTargets([])).toEqual({ settled: false });
  });

  it("settles PUBLISHED when every target published", () => {
    expect(resolvePostStatusFromTargets([t("PUBLISHED"), t("PUBLISHED")])).toEqual({
      settled: true,
      status: "PUBLISHED",
    });
  });

  it("settles FAILED when every target failed", () => {
    expect(resolvePostStatusFromTargets([t("FAILED"), t("FAILED")])).toEqual({
      settled: true,
      status: "FAILED",
    });
  });

  it("settles PUBLISHED on a mixed published/failed outcome", () => {
    // Pre-existing behaviour: something went live, so the post is published.
    expect(resolvePostStatusFromTargets([t("PUBLISHED"), t("FAILED")])).toEqual({
      settled: true,
      status: "PUBLISHED",
    });
  });

  describe("CANCELLED is excluded from the verdict", () => {
    it("🔴 FAILED + CANCELLED settles FAILED, never PUBLISHED", () => {
      // THE trap this helper exists to make unrepresentable. Widening an
      // "all done?" check to admit CANCELLED while leaving a separate
      // "all failed?" check alone yields allDone=true, allFailed=false, and the
      // post is written PUBLISHED — announcing a success that never happened.
      expect(resolvePostStatusFromTargets([t("FAILED"), t("CANCELLED")])).toEqual({
        settled: true,
        status: "FAILED",
      });
    });

    it("PUBLISHED + CANCELLED settles PUBLISHED", () => {
      expect(resolvePostStatusFromTargets([t("PUBLISHED"), t("CANCELLED")])).toEqual({
        settled: true,
        status: "PUBLISHED",
      });
    });

    it("every target CANCELLED settles CANCELLED, not FAILED", () => {
      // Reporting a deliberate cancel as a failure is what the watchdog used to
      // do 45 minutes after the fact.
      expect(resolvePostStatusFromTargets([t("CANCELLED"), t("CANCELLED")])).toEqual({
        settled: true,
        status: "CANCELLED",
      });
    });

    it("PUBLISHED + FAILED + CANCELLED settles PUBLISHED", () => {
      expect(
        resolvePostStatusFromTargets([t("PUBLISHED"), t("FAILED"), t("CANCELLED")])
      ).toEqual({ settled: true, status: "PUBLISHED" });
    });
  });
});

describe("CANCELLABLE_TARGET_STATUSES", () => {
  it("covers exactly the queued-but-not-dispatched statuses", () => {
    expect([...CANCELLABLE_TARGET_STATUSES].sort()).toEqual(["DRAFT", "SCHEDULED"]);
  });

  it("🔴 never admits PUBLISHING, PUBLISHED or FAILED", () => {
    // PUBLISHING: a job holds it and the platform will answer — cancelling is a
    // promise we cannot keep. PUBLISHED: live, unrecallable. FAILED: already
    // settled; relabelling would erase why it failed.
    expect(isCancellableStatus("PUBLISHING")).toBe(false);
    expect(isCancellableStatus("PUBLISHED")).toBe(false);
    expect(isCancellableStatus("FAILED")).toBe(false);
    expect(isCancellableStatus("CANCELLED")).toBe(false);
  });

  it("admits the queued ones", () => {
    expect(isCancellableStatus("SCHEDULED")).toBe(true);
    expect(isCancellableStatus("DRAFT")).toBe(true);
  });

  // ⚠️ The "CANCELLED is not in the publish claim" property is THE safety
  // argument for this feature, and it cannot be asserted here: packages/queue
  // must not import from apps/worker, where PUBLISH_CLAIM_STATUSES lives. It is
  // asserted against the REAL constant in
  // apps/worker/src/__tests__/cancel-remaining-guards.test.ts. A copy of the
  // literal here would have been tautologically true and proved nothing.
});
