/**
 * Regression guard for the AI-video plan gate in the repurpose router.
 *
 * Bug: the gate was a hand-rolled `org.plan === "FREE"||"STARTER"` check that
 * ignored isSuperAdmin, so superadmin tabish@dashmani.com (personal org on
 * FREE) was wrongly blocked from AI video. It now uses `requirePlan(...,
 * ctx.isSuperAdmin)`. These tests lock in the correct matrix:
 *   - superadmin  → bypass (no throw) regardless of plan
 *   - FREE/STARTER non-superadmin → FORBIDDEN
 *   - PROFESSIONAL/ENTERPRISE non-superadmin → allowed
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB the middleware reads.
const findUniqueOrThrow = vi.fn();
vi.mock("@postautomation/db", () => ({
  prisma: { organization: { findUniqueOrThrow: (...a: any[]) => findUniqueOrThrow(...a) } },
}));

import { requirePlan } from "../middleware/plan-limit.middleware";

describe("repurpose AI-video plan gate (requirePlan PROFESSIONAL)", () => {
  beforeEach(() => findUniqueOrThrow.mockReset());

  it("superadmin bypasses the gate even on FREE (the reported bug)", async () => {
    findUniqueOrThrow.mockResolvedValue({ plan: "FREE" });
    await expect(
      requirePlan("org-1", "PROFESSIONAL", "AI video generation", true)
    ).resolves.toBeUndefined();
    // Superadmin short-circuits BEFORE any DB read.
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("FREE non-superadmin is blocked with FORBIDDEN", async () => {
    findUniqueOrThrow.mockResolvedValue({ plan: "FREE" });
    await expect(
      requirePlan("org-1", "PROFESSIONAL", "AI video generation", false)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("STARTER non-superadmin is blocked", async () => {
    findUniqueOrThrow.mockResolvedValue({ plan: "STARTER" });
    await expect(
      requirePlan("org-1", "PROFESSIONAL", "AI video generation", false)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("PROFESSIONAL non-superadmin is allowed", async () => {
    findUniqueOrThrow.mockResolvedValue({ plan: "PROFESSIONAL" });
    await expect(
      requirePlan("org-1", "PROFESSIONAL", "AI video generation", false)
    ).resolves.toBeUndefined();
  });

  it("ENTERPRISE non-superadmin is allowed", async () => {
    findUniqueOrThrow.mockResolvedValue({ plan: "ENTERPRISE" });
    await expect(
      requirePlan("org-1", "PROFESSIONAL", "AI video generation", false)
    ).resolves.toBeUndefined();
  });
});
