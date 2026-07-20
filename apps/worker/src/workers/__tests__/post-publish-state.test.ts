import { describe, it, expect, vi } from "vitest";
import {
  markTargetFailed,
  mediaRequiredReason,
  terminalizeStuckClaim,
  isStaleScheduleJob,
} from "../../lib/publish-recovery";

/** Mirror of the worker's classifyError media_required branch (worker line 199). */
function classifyMediaError(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes("requires at least one image") || m.includes("media required");
}

describe("media-required publish path", () => {
  it("classifies the Instagram validation error as media_required", () => {
    // The exact string instagram.provider.ts:80 pushes.
    expect(
      classifyMediaError("Instagram requires at least one image or video to publish a post."),
    ).toBe(true);
  });

  it("writes a FAILED target with the human media-required reason", async () => {
    const update = vi.fn<(arg: { where: { id: string }; data: { status: string; errorMessage: string } }) => Promise<object>>(async () => ({}));
    const prisma = { postTarget: { update } } as any;

    await markTargetFailed(prisma, "target-1", mediaRequiredReason("INSTAGRAM"));

    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0]![0]!;
    expect(arg.where).toEqual({ id: "target-1" });
    expect(arg.data.status).toBe("FAILED");
    expect(arg.data.errorMessage).toContain("Instagram");
    expect(arg.data.errorMessage.toLowerCase()).toContain("image");
  });
});

describe("final-attempt orphan terminalization", () => {
  it("forces FAILED when a double-claim no-op lands on the final attempt", async () => {
    // Simulate the worker claim guard's decision + the resulting DB write.
    const claimCount = 0; // target was already PUBLISHING → updateMany matched nothing
    const isFinalAttempt = true; // job.attemptsMade + 1 >= attempts

    const shouldFail = terminalizeStuckClaim({ claimCount, isFinalAttempt });
    expect(shouldFail).toBe(true);

    const update = vi.fn<(arg: { where: { id: string }; data: { status: string; errorMessage: string } }) => Promise<object>>(async () => ({}));
    const prisma = { postTarget: { update } } as any;
    if (shouldFail) {
      await markTargetFailed(prisma, "target-2", "Publishing did not complete after all retries — please retry.");
    }
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]!.data.status).toBe("FAILED");
  });

  it("does NOT force FAILED on a non-final no-op claim", () => {
    expect(terminalizeStuckClaim({ claimCount: 0, isFinalAttempt: false })).toBe(false);
  });

  it("does NOT force FAILED when the claim succeeded", () => {
    expect(terminalizeStuckClaim({ claimCount: 1, isFinalAttempt: true })).toBe(false);
  });
});

describe("isStaleScheduleJob (Phase 2 exact-time guard)", () => {
  const T0 = 1_800_000_000_000;

  it("matches when the post's scheduledAt equals the enqueue snapshot", () => {
    expect(isStaleScheduleJob(T0, new Date(T0))).toBe(false);
  });

  it("tolerates sub-second storage truncation", () => {
    expect(isStaleScheduleJob(T0, new Date(T0 + 999))).toBe(false);
  });

  it("is stale after a reschedule (scheduledAt moved)", () => {
    expect(isStaleScheduleJob(T0, new Date(T0 + 30_000))).toBe(true);
    expect(isStaleScheduleJob(T0, new Date(T0 - 30_000))).toBe(true);
  });

  it("is stale when the post was unscheduled or deleted (null scheduledAt)", () => {
    expect(isStaleScheduleJob(T0, null)).toBe(true);
    expect(isStaleScheduleJob(T0, undefined)).toBe(true);
  });

  it("is stale after publishNow reset scheduledAt to the click time", () => {
    // publishNow sets scheduledAt = now; the orphaned creation-time job for
    // the original (future) schedule must not fire at the old time.
    expect(isStaleScheduleJob(T0 + 3_600_000, new Date(T0))).toBe(true);
  });
});
