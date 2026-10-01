/**
 * billing.createPortalSession must be OWNER-only, exactly like its sibling
 * createCheckout right above it in the same router (security audit 2026-09-28,
 * confirmed medium).
 *
 * Both are adminOrgProcedure (any app-role ADMIN, or every user under
 * RBAC_DISABLED=true), which says nothing about ORG role. createCheckout
 * additionally checks `ctx.membership.role !== "OWNER"`; createPortalSession
 * did not, so a non-OWNER member of the workspace who happens to hold the
 * app-wide ADMIN role could open the org's live Stripe customer portal —
 * change payment methods, cancel the subscription, alter billing on someone
 * else's org, a workspace they don't own.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@postautomation/billing", () => ({
  createCheckoutSession: vi.fn(async () => ({ url: "https://checkout.stripe.com/x" })),
  createCustomerPortalSession: vi.fn(async () => ({ url: "https://billing.stripe.com/x" })),
  getStripe: vi.fn(),
}));
vi.mock("../lib/audit", () => ({ createAuditLog: vi.fn(async () => {}), AUDIT_ACTIONS: { BILLING_CHECKOUT_STARTED: "x" } }));
vi.mock("../middleware/plan-limit.middleware", () => ({
  checkUsageLimit: vi.fn(),
  isBillingDisabled: () => false,
}));

const orgMemberFindUnique = vi.fn();
const orgFindUnique = vi.fn(async (_a: any) => null); // orgProcedure's own planExpiresAt check
const orgFindUniqueOrThrow = vi.fn(async (_a: any) => ({ id: "org-1", stripeCustomerId: "cus_123" }));

vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: { findUnique: (a: any) => orgMemberFindUnique(a) },
    organization: {
      findUnique: (a: any) => orgFindUnique(a),
      findUniqueOrThrow: (a: any) => orgFindUniqueOrThrow(a),
    },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { billingRouter } from "../routers/billing.router";

const ORG_ID = "org-1";

function callerAs(role: "OWNER" | "ADMIN" | "MEMBER") {
  orgMemberFindUnique.mockResolvedValue({ userId: "u1", organizationId: ORG_ID, role });
  return createCallerFactory(billingRouter)({
    prisma: {
      organizationMember: { findUnique: (a: any) => orgMemberFindUnique(a) },
      organization: { findUnique: (a: any) => orgFindUnique(a), findUniqueOrThrow: (a: any) => orgFindUniqueOrThrow(a) },
    } as any,
    organizationId: ORG_ID,
    session: { user: { id: "u1", email: "u@x.com", isSuperAdmin: false, appRole: "ADMIN" }, expires: "2099-01-01" } as any,
  } as any);
}

beforeEach(() => vi.clearAllMocks());

describe("billing.createPortalSession", () => {
  it("refuses a non-OWNER org member, even with the app-wide ADMIN role", async () => {
    await expect(callerAs("ADMIN").createPortalSession()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerAs("MEMBER").createPortalSession()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows the org OWNER", async () => {
    await expect(callerAs("OWNER").createPortalSession()).resolves.toMatchObject({
      url: "https://billing.stripe.com/x",
    });
  });
});

describe("billing.createCheckout (unchanged — confirms the sibling guard as the reference)", () => {
  it("still refuses a non-OWNER", async () => {
    await expect(callerAs("MEMBER").createCheckout({ planType: "STARTER" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
