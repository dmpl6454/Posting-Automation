/**
 * Regression guard for the temporary BILLING_DISABLED switch (2026-06-11).
 *
 * Decision: while BILLING_DISABLED=true, every org (new + old, any plan) bypasses
 * ALL plan/quota gates so users have free rein. Billing code stays intact; re-arm
 * by unsetting the flag. These tests lock TWO things against the REAL middleware
 * with a mocked DB (same style as chat-action-gating / repurpose-plan-gate):
 *
 *   1. flag ON  → FREE non-superadmin passes a PROFESSIONAL feature gate and an
 *      over-quota check, WITHOUT touching the DB (short-circuit before findUnique).
 *   2. flag OFF → enforcement is exactly as before (no behavior change shipped).
 *
 * The DB mock returns over-limit values so that, if the bypass ever regresses,
 * the "flag ON" cases would throw FORBIDDEN and fail loudly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const orgFindUniqueOrThrow = vi.fn();
const postCount = vi.fn();
const mediaCount = vi.fn();
const channelCount = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: {
    organization: { findUniqueOrThrow: (...a: any[]) => orgFindUniqueOrThrow(...a) },
    post: { count: (...a: any[]) => postCount(...a) },
    media: { count: (...a: any[]) => mediaCount(...a) },
    channel: { count: (...a: any[]) => channelCount(...a) },
  },
}));

import {
  requirePlan,
  enforcePlanLimit,
  checkUsageLimit,
  isBillingDisabled,
} from "../middleware/plan-limit.middleware";

describe("BILLING_DISABLED temporary switch", () => {
  const original = process.env.BILLING_DISABLED;

  beforeEach(() => {
    orgFindUniqueOrThrow.mockReset();
    postCount.mockReset();
    mediaCount.mockReset();
    channelCount.mockReset();
    // Default the mocks to over-limit / lowest tier so a regressed bypass throws.
    orgFindUniqueOrThrow.mockResolvedValue({ plan: "FREE" });
    postCount.mockResolvedValue(9999);
    mediaCount.mockResolvedValue(9999);
    channelCount.mockResolvedValue(9999);
  });

  afterEach(() => {
    if (original === undefined) delete process.env.BILLING_DISABLED;
    else process.env.BILLING_DISABLED = original;
  });

  describe("flag ON (BILLING_DISABLED=true)", () => {
    beforeEach(() => {
      process.env.BILLING_DISABLED = "true";
    });

    it("isBillingDisabled() reports true", () => {
      expect(isBillingDisabled()).toBe(true);
    });

    it("FREE non-superadmin passes a PROFESSIONAL feature gate without a DB read", async () => {
      await expect(
        requirePlan("org-1", "PROFESSIONAL", "Campaigns", false)
      ).resolves.toBeUndefined();
      expect(orgFindUniqueOrThrow).not.toHaveBeenCalled();
    });

    it("FREE non-superadmin passes an over-quota check without a DB read", async () => {
      await expect(
        enforcePlanLimit("org-1", "postsPerMonth", false)
      ).resolves.toBeUndefined();
      expect(orgFindUniqueOrThrow).not.toHaveBeenCalled();
      expect(postCount).not.toHaveBeenCalled();
    });

    it("checkUsageLimit returns unlimited for every resource", async () => {
      for (const resource of [
        "channels",
        "postsPerMonth",
        "aiImagesPerMonth",
        "aiVideosPerMonth",
        "teamMembers",
      ] as const) {
        const result = await checkUsageLimit("org-1", resource, false);
        expect(result).toEqual({ allowed: true, current: 0, limit: -1, planName: "Unlimited" });
      }
    });
  });

  describe("flag OFF (unset) — enforcement unchanged", () => {
    beforeEach(() => {
      delete process.env.BILLING_DISABLED;
    });

    it("isBillingDisabled() reports false", () => {
      expect(isBillingDisabled()).toBe(false);
    });

    it("FREE non-superadmin is still blocked from a PROFESSIONAL feature", async () => {
      await expect(
        requirePlan("org-1", "PROFESSIONAL", "Campaigns", false)
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("FREE non-superadmin over postsPerMonth is still blocked", async () => {
      await expect(
        enforcePlanLimit("org-1", "postsPerMonth", false)
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("FREE under quota is still allowed", async () => {
      postCount.mockResolvedValue(5);
      await expect(
        enforcePlanLimit("org-1", "postsPerMonth", false)
      ).resolves.toBeUndefined();
    });
  });

  it("flag set to a non-\"true\" value does NOT disable billing", async () => {
    process.env.BILLING_DISABLED = "1";
    expect(isBillingDisabled()).toBe(false);
    await expect(
      requirePlan("org-1", "PROFESSIONAL", "Campaigns", false)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
