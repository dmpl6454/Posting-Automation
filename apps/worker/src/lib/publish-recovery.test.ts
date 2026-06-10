import { describe, it, expect, vi } from "vitest";
import { markTargetFailed, shouldReapPublishing } from "./publish-recovery";

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
