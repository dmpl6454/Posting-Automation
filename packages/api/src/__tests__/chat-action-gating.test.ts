/**
 * Regression guard for the Super Agent plan-gating fix (audit 2026-06-06).
 *
 * Bug: chat.router.ts executeAction had ZERO plan gating, so a FREE user could
 * create autopilot agents (a STARTER feature) and exceed post/image quotas via
 * chat. The actions now call requirePlan/enforcePlanLimit with ctx.isSuperAdmin
 * passthrough. These tests lock the tier matrix the actions rely on, exercising
 * the REAL middleware against a mocked DB (same style as repurpose-plan-gate).
 *
 * Action → gate mapping under test:
 *   create_agent        → requirePlan(STARTER)
 *   schedule_post       → enforcePlanLimit(postsPerMonth)
 *   bulk_schedule       → enforcePlanLimit(postsPerMonth)  (per post)
 *   publish_now         → enforcePlanLimit(postsPerMonth)
 *   generate_news_image → enforcePlanLimit(aiImagesPerMonth)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { requirePlan, enforcePlanLimit } from "../middleware/plan-limit.middleware";

describe("Super Agent action gating", () => {
  beforeEach(() => {
    orgFindUniqueOrThrow.mockReset();
    postCount.mockReset();
    mediaCount.mockReset();
    channelCount.mockReset();
  });

  describe("create_agent requires STARTER", () => {
    it("FREE non-superadmin is blocked", async () => {
      orgFindUniqueOrThrow.mockResolvedValue({ plan: "FREE" });
      await expect(
        requirePlan("org-1", "STARTER", "Autopilot agents", false)
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("STARTER non-superadmin is allowed", async () => {
      orgFindUniqueOrThrow.mockResolvedValue({ plan: "STARTER" });
      await expect(
        requirePlan("org-1", "STARTER", "Autopilot agents", false)
      ).resolves.toBeUndefined();
    });

    it("superadmin bypasses regardless of plan (no DB read)", async () => {
      await expect(
        requirePlan("org-1", "STARTER", "Autopilot agents", true)
      ).resolves.toBeUndefined();
      expect(orgFindUniqueOrThrow).not.toHaveBeenCalled();
    });
  });

  describe("post/image quotas", () => {
    it("FREE over postsPerMonth (30) blocks schedule/publish", async () => {
      orgFindUniqueOrThrow.mockResolvedValue({ plan: "FREE" });
      postCount.mockResolvedValue(30);
      await expect(
        enforcePlanLimit("org-1", "postsPerMonth", false)
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("FREE under postsPerMonth is allowed", async () => {
      orgFindUniqueOrThrow.mockResolvedValue({ plan: "FREE" });
      postCount.mockResolvedValue(5);
      await expect(
        enforcePlanLimit("org-1", "postsPerMonth", false)
      ).resolves.toBeUndefined();
    });

    it("FREE over aiImagesPerMonth (50) blocks generate_news_image", async () => {
      orgFindUniqueOrThrow.mockResolvedValue({ plan: "FREE" });
      mediaCount.mockResolvedValue(50);
      await expect(
        enforcePlanLimit("org-1", "aiImagesPerMonth", false)
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("superadmin is never quota-limited (no DB read)", async () => {
      await expect(
        enforcePlanLimit("org-1", "postsPerMonth", true)
      ).resolves.toBeUndefined();
      expect(orgFindUniqueOrThrow).not.toHaveBeenCalled();
    });

    it("PROFESSIONAL has unlimited posts (limit -1)", async () => {
      orgFindUniqueOrThrow.mockResolvedValue({ plan: "PROFESSIONAL" });
      await expect(
        enforcePlanLimit("org-1", "postsPerMonth", false)
      ).resolves.toBeUndefined();
    });
  });
});
