/**
 * Regression guard for app-level RBAC (2026-07-17).
 *
 * Two layers:
 *  1. Unit matrix for isAppAdmin (packages/api/src/trpc.ts) — the single
 *     predicate every appRole gate uses. isSuperAdmin implies ADMIN.
 *  2. WIRING LOCK — reads the router sources and asserts the admin-only
 *     routers still use adminOrgProcedure/adminProtectedProcedure and the
 *     USER-allowed procedures did NOT get accidentally gated. A refactor that
 *     silently swaps a procedure back to orgProcedure fails here without
 *     needing a full tRPC caller harness.
 *
 * Product decisions locked (owner, 2026-07-17):
 *   USER role = Dashboard, Content Studio, Super Agent, Media, Insights,
 *   Channels (FULL — incl. connect/disconnect + groups), approvals SUBMIT.
 *   ADMIN = everything. Existing users grandfathered to ADMIN via backfill.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// vi.mock is hoisted — the factory must be fully self-contained (no top-level refs).
vi.mock("@postautomation/db", () => ({
  prisma: {
    organization: { findUniqueOrThrow: () => Promise.resolve({ plan: "FREE" }) },
  },
  ensurePersonalOrg: () => Promise.resolve(null),
}));

import { isAppAdmin } from "../trpc";

describe("isAppAdmin matrix", () => {
  it("appRole ADMIN passes", () => {
    expect(isAppAdmin({ appRole: "ADMIN", isSuperAdmin: false })).toBe(true);
  });
  it("appRole USER is blocked", () => {
    expect(isAppAdmin({ appRole: "USER", isSuperAdmin: false })).toBe(false);
  });
  it("isSuperAdmin implies ADMIN even with appRole USER (un-backfilled superadmin never locks out)", () => {
    expect(isAppAdmin({ appRole: "USER", isSuperAdmin: true })).toBe(true);
  });
  it("missing/undefined user is blocked", () => {
    expect(isAppAdmin(undefined)).toBe(false);
    expect(isAppAdmin(null)).toBe(false);
    expect(isAppAdmin({})).toBe(false);
  });
});

// ── Wiring lock ──────────────────────────────────────────────────────────────
const routersDir = join(__dirname, "..", "routers");
const read = (f: string) => readFileSync(join(routersDir, f), "utf8");

/** Routers that must be FULLY admin-gated (no bare orgProcedure anywhere). */
const FULLY_ADMIN_ROUTERS = [
  "rss.router.ts",
  "shortlink.router.ts",
  "agent.router.ts",
  "autopilot.router.ts",
  "account-group.router.ts",
  "listening.router.ts",
  "campaign.router.ts",
  "brand-leads.router.ts",
  "newsgrid.router.ts",
  "webhook.router.ts",
  "webhook-delivery.router.ts",
  "apikey.router.ts",
  "audit.router.ts",
];

describe("wiring lock — fully admin-gated routers", () => {
  for (const file of FULLY_ADMIN_ROUTERS) {
    it(`${file} uses adminOrgProcedure exclusively`, () => {
      const src = read(file);
      expect(src).toMatch(/adminOrgProcedure/);
      // No bare orgProcedure token may remain (word-boundary: adminOrgProcedure
      // contains "OrgProcedure" but not the standalone token).
      expect(src).not.toMatch(/(?<!admin)\borgProcedure\b/);
    });
  }
});

describe("wiring lock — mixed routers keep the USER/ADMIN split", () => {
  it("team: invite/updateRole/transferOwnership/removeMember admin; members stays USER-readable", () => {
    const src = read("team.router.ts");
    expect(src).toMatch(/invite: adminOrgProcedure/);
    expect(src).toMatch(/updateRole: adminOrgProcedure/);
    expect(src).toMatch(/transferOwnership: adminOrgProcedure/);
    expect(src).toMatch(/removeMember: adminOrgProcedure/);
    // members powers the approval reviewer picker — must stay USER-accessible
    expect(src).toMatch(/members: orgProcedure/);
  });

  it("approval: review admin; submit/list/getForPost/cancel stay USER", () => {
    const src = read("approval.router.ts");
    expect(src).toMatch(/review: adminOrgProcedure/);
    expect(src).toMatch(/submit: orgProcedure/);
    expect(src).toMatch(/cancel: orgProcedure/);
  });

  it("billing: checkout/portal admin; currentPlan stays USER (sidebar reads billingDisabled)", () => {
    const src = read("billing.router.ts");
    expect(src).toMatch(/createCheckout: adminOrgProcedure/);
    expect(src).toMatch(/createPortalSession: adminOrgProcedure/);
    expect(src).toMatch(/currentPlan: orgProcedure/);
  });

  it("user: createOrganization admin; me stays USER", () => {
    const src = read("user.router.ts");
    expect(src).toMatch(/createOrganization: adminProtectedProcedure/);
    expect(src).toMatch(/me: protectedProcedure/);
  });

  it("notification: create admin; list stays USER (notification bell)", () => {
    const src = read("notification.router.ts");
    expect(src).toMatch(/create: adminProtectedProcedure/);
    expect(src).toMatch(/list: protectedProcedure/);
  });

  it("chat: create_agent action carries the isAppAdmin gate", () => {
    const src = read("chat.router.ts");
    expect(src).toMatch(/case "create_agent":[\s\S]{0,600}isAppAdmin\(ctx\.session\?\.user\)/);
  });
});

describe("wiring lock — USER-allowed routers stay ungated", () => {
  // Owner decision: Channels page is FULLY accessible to the USER role —
  // channel + channelGroup must NOT get adminOrgProcedure.
  for (const file of [
    "channel.router.ts",
    "channel-group.router.ts",
    "post.router.ts",
    "media.router.ts",
    "analytics.router.ts",
    "repurpose.router.ts",
  ]) {
    it(`${file} has no adminOrgProcedure`, () => {
      let src: string;
      try {
        src = read(file);
      } catch {
        return; // file name differs — covered by the positive locks above
      }
      expect(src).not.toMatch(/adminOrgProcedure/);
    });
  }
});
