/**
 * Regression guard for the Super Agent RBAC side door (Phase-B audit §3 gap,
 * fixed 2026-07-18).
 *
 * Bug class: chat executeAction's create_campaign / create_brand_tracker /
 * create_listening_query cases had NO isAppAdmin gate while their dedicated
 * routers (campaign.router, listening.router) are fully adminOrgProcedure-gated
 * — a USER-role account could create campaigns/trackers/listening queries via
 * chat that the normal UI forbids.
 *
 * Two layers (same style as app-role-gating.test.ts + chat-action-gating.test.ts):
 *  1. Behavior matrix — the exact gate predicate the router inlines
 *     (`RBAC_DISABLED !== "true" && !isAppAdmin(user)` → FORBIDDEN) exercised
 *     with USER / ADMIN / superadmin users, plus requirePlan(PROFESSIONAL) for
 *     create_campaign against the REAL middleware.
 *  2. WIRING LOCK — reads chat.router.ts source and asserts each of the three
 *     cases still carries the isAppAdmin gate (a refactor that drops it fails
 *     here without a full tRPC caller harness).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TRPCError } from "@trpc/server";

const orgFindUniqueOrThrow = vi.fn();

// vi.mock is hoisted — factory must be self-contained.
vi.mock("@postautomation/db", () => ({
  prisma: {
    organization: { findUniqueOrThrow: (...a: any[]) => orgFindUniqueOrThrow(...a) },
  },
  ensurePersonalOrg: () => Promise.resolve(null),
}));

import { isAppAdmin } from "../trpc";
import { requirePlan } from "../middleware/plan-limit.middleware";

/**
 * EXACT replica of the inline gate each of the three cases now carries
 * (mirrors create_agent, chat.router.ts). Kept in lock-step by the wiring-lock
 * assertions below.
 */
function chatAdminGate(user: unknown, message: string): void {
  if (process.env.RBAC_DISABLED !== "true" && !isAppAdmin(user)) {
    throw new TRPCError({ code: "FORBIDDEN", message });
  }
}

const ACTIONS = [
  { action: "create_campaign", message: "Creating campaigns requires an admin role." },
  { action: "create_brand_tracker", message: "Creating brand trackers requires an admin role." },
  { action: "create_listening_query", message: "Creating listening queries requires an admin role." },
] as const;

describe("chat RBAC side-door gate — behavior matrix", () => {
  const savedRbac = process.env.RBAC_DISABLED;
  beforeEach(() => {
    delete process.env.RBAC_DISABLED;
    orgFindUniqueOrThrow.mockReset();
  });
  afterEach(() => {
    if (savedRbac === undefined) delete process.env.RBAC_DISABLED;
    else process.env.RBAC_DISABLED = savedRbac;
  });

  for (const { action, message } of ACTIONS) {
    it(`${action}: USER appRole gets FORBIDDEN`, () => {
      expect(() => chatAdminGate({ appRole: "USER", isSuperAdmin: false }, message)).toThrowError(
        expect.objectContaining({ code: "FORBIDDEN", message })
      );
    });

    it(`${action}: ADMIN appRole passes the gate`, () => {
      expect(() => chatAdminGate({ appRole: "ADMIN", isSuperAdmin: false }, message)).not.toThrow();
    });

    it(`${action}: superadmin (even with USER appRole) passes`, () => {
      expect(() => chatAdminGate({ appRole: "USER", isSuperAdmin: true }, message)).not.toThrow();
    });

    it(`${action}: missing session user is blocked`, () => {
      expect(() => chatAdminGate(undefined, message)).toThrowError(
        expect.objectContaining({ code: "FORBIDDEN" })
      );
    });

    it(`${action}: RBAC_DISABLED=true kill switch bypasses the gate`, () => {
      process.env.RBAC_DISABLED = "true";
      expect(() => chatAdminGate({ appRole: "USER", isSuperAdmin: false }, message)).not.toThrow();
    });
  }

  describe("create_campaign additionally requires PROFESSIONAL (mirrors gateCampaigns)", () => {
    it("FREE non-superadmin is blocked", async () => {
      orgFindUniqueOrThrow.mockResolvedValue({ plan: "FREE" });
      await expect(
        requirePlan("org-1", "PROFESSIONAL", "Campaigns", false)
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("PROFESSIONAL non-superadmin is allowed", async () => {
      orgFindUniqueOrThrow.mockResolvedValue({ plan: "PROFESSIONAL" });
      await expect(
        requirePlan("org-1", "PROFESSIONAL", "Campaigns", false)
      ).resolves.toBeUndefined();
    });

    it("superadmin bypasses regardless of plan (no DB read)", async () => {
      await expect(
        requirePlan("org-1", "PROFESSIONAL", "Campaigns", true)
      ).resolves.toBeUndefined();
      expect(orgFindUniqueOrThrow).not.toHaveBeenCalled();
    });
  });
});

// ── Wiring lock ──────────────────────────────────────────────────────────────
describe("chat RBAC side-door gate — wiring lock", () => {
  const src = readFileSync(join(__dirname, "..", "routers", "chat.router.ts"), "utf8");

  it("create_campaign carries the isAppAdmin gate + FORBIDDEN", () => {
    expect(src).toMatch(
      /case "create_campaign":[\s\S]{0,700}RBAC_DISABLED[\s\S]{0,120}isAppAdmin\(ctx\.session\?\.user\)[\s\S]{0,300}FORBIDDEN/
    );
  });

  it("create_campaign also calls requirePlan PROFESSIONAL before any DB write", () => {
    const caseBody = src.split('case "create_campaign":')[1]!.split('case "create_brand_tracker":')[0]!;
    const planIdx = caseBody.indexOf('requirePlan(ctx.organizationId, "PROFESSIONAL", "Campaigns", ctx.isSuperAdmin)');
    const createIdx = caseBody.indexOf("campaign.create");
    expect(planIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(-1);
    expect(planIdx).toBeLessThan(createIdx);
  });

  it("create_brand_tracker carries the isAppAdmin gate + FORBIDDEN", () => {
    expect(src).toMatch(
      /case "create_brand_tracker":[\s\S]{0,700}RBAC_DISABLED[\s\S]{0,120}isAppAdmin\(ctx\.session\?\.user\)[\s\S]{0,300}FORBIDDEN/
    );
  });

  it("create_listening_query carries the isAppAdmin gate + FORBIDDEN", () => {
    expect(src).toMatch(
      /case "create_listening_query":[\s\S]{0,700}RBAC_DISABLED[\s\S]{0,120}isAppAdmin\(ctx\.session\?\.user\)[\s\S]{0,300}FORBIDDEN/
    );
  });

  it("gate precedes the DB create in every case (no write-then-throw)", () => {
    for (const [caseLabel, createCall] of [
      ['case "create_campaign":', "campaign.create"],
      ['case "create_brand_tracker":', "brandTracker.create"],
      ['case "create_listening_query":', "listeningQuery.create"],
    ] as const) {
      const after = src.split(caseLabel)[1]!;
      const gateIdx = after.indexOf("isAppAdmin(ctx.session?.user)");
      const createIdx = after.indexOf(createCall);
      expect(gateIdx, `${caseLabel} missing gate`).toBeGreaterThan(-1);
      expect(createIdx, `${caseLabel} missing create`).toBeGreaterThan(-1);
      expect(gateIdx, `${caseLabel} gate must precede the DB write`).toBeLessThan(createIdx);
    }
  });
});
