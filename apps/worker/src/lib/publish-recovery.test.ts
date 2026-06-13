import { describe, it, expect, vi } from "vitest";
import { markTargetFailed, shouldReapPublishing, mediaRequiredReason, terminalizeStuckClaim } from "./publish-recovery";

describe("shouldReapPublishing", () => {
  const now = new Date("2026-06-10T12:00:00.000Z");

  it("reaps a PUBLISHING target last updated 31 min ago", () => {
    const updatedAt = new Date(now.getTime() - 31 * 60 * 1000);
    expect(shouldReapPublishing({ status: "PUBLISHING", updatedAt }, now)).toBe(true);
  });

  it("does NOT reap a PUBLISHING target last updated 5 min ago", () => {
    const updatedAt = new Date(now.getTime() - 5 * 60 * 1000);
    expect(shouldReapPublishing({ status: "PUBLISHING", updatedAt }, now)).toBe(false);
  });

  it("does NOT reap a PUBLISHED target even if 31 min old", () => {
    const updatedAt = new Date(now.getTime() - 31 * 60 * 1000);
    expect(shouldReapPublishing({ status: "PUBLISHED", updatedAt }, now)).toBe(false);
  });

  it("honors a custom maxAgeMs threshold", () => {
    const updatedAt = new Date(now.getTime() - 90 * 1000); // 90s ago
    expect(shouldReapPublishing({ status: "PUBLISHING", updatedAt }, now, 60 * 1000)).toBe(true);
    expect(shouldReapPublishing({ status: "PUBLISHING", updatedAt }, now, 120 * 1000)).toBe(false);
  });
});

describe("markTargetFailed", () => {
  it("issues a postTarget.update with status FAILED and the message", async () => {
    const update = vi.fn().mockResolvedValue({});
    const prisma = { postTarget: { update } };

    await markTargetFailed(prisma, "pt_123", "Token expired and refresh failed");

    expect(update).toHaveBeenCalledWith({
      where: { id: "pt_123" },
      data: { status: "FAILED", errorMessage: "Token expired and refresh failed" },
    });
  });

  it("swallows DB errors so the original publish error can propagate", async () => {
    const update = vi.fn().mockRejectedValue(new Error("db down"));
    const prisma = { postTarget: { update } };

    await expect(
      markTargetFailed(prisma, "pt_456", "some message"),
    ).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledOnce();
  });
});

describe("mediaRequiredReason", () => {
  it("names Instagram in the reason", () => {
    const msg = mediaRequiredReason("INSTAGRAM");
    expect(msg).toContain("Instagram");
    expect(msg.toLowerCase()).toContain("image");
  });

  it("names Facebook in the reason", () => {
    expect(mediaRequiredReason("FACEBOOK")).toContain("Facebook");
  });

  it("falls back to the raw platform for an unmapped platform", () => {
    expect(mediaRequiredReason("THREADS")).toContain("THREADS");
  });
});

describe("terminalizeStuckClaim", () => {
  it("terminalizes when the claim found nothing on the final attempt", () => {
    expect(terminalizeStuckClaim({ claimCount: 0, isFinalAttempt: true })).toBe(true);
  });

  it("does NOT terminalize on a non-final no-op claim (a later attempt may succeed)", () => {
    expect(terminalizeStuckClaim({ claimCount: 0, isFinalAttempt: false })).toBe(false);
  });

  it("does NOT terminalize when the claim succeeded (count > 0)", () => {
    expect(terminalizeStuckClaim({ claimCount: 1, isFinalAttempt: true })).toBe(false);
  });
});

describe("watchdog reap invariant", () => {
  it("reaps a target orphaned at PUBLISHING whose updatedAt was NOT refreshed by no-op retries", () => {
    // A no-op claim (count===0) writes no row, so @updatedAt is not bumped — the
    // orphan keeps aging and crosses the 30-min threshold.
    const now = new Date("2026-06-13T12:00:00.000Z");
    const orphanedAt = new Date(now.getTime() - 31 * 60 * 1000); // last real write 31 min ago
    expect(shouldReapPublishing({ status: "PUBLISHING", updatedAt: orphanedAt }, now)).toBe(true);
  });

  it("does NOT reap a target that the worker just terminalized to FAILED", () => {
    const now = new Date("2026-06-13T12:00:00.000Z");
    const justFailed = new Date(now.getTime() - 31 * 60 * 1000);
    // FAILED is terminal — the reaper's status:PUBLISHING filter excludes it.
    expect(shouldReapPublishing({ status: "FAILED", updatedAt: justFailed }, now)).toBe(false);
  });
});
