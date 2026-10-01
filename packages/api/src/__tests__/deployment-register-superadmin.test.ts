/**
 * deployment.register let any org's app-ADMIN forge the platform-wide active
 * deployment row (security audit 2026-09-28).
 *
 * `Deployment` has no organizationId — it is a GLOBAL, platform-wide table
 * (see the comment already on `rollback`, which was fixed to superAdminProcedure
 * for exactly this reason: "deployments are global, not org-scoped"). `register`
 * is the more dangerous sibling of that same bug: any app-ADMIN of ANY
 * organization — including a free workspace they created themselves — could
 * call it to mark every other deployment "superseded" and insert a fake
 * "active" one with an arbitrary version/commitHash/commitMsg/branch, which
 * every admin across the platform (deployment.current is adminOrgProcedure)
 * would then see as the real running build. Must be superAdminProcedure, like
 * rollback.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const deploymentUpdateMany = vi.fn(async (..._a: any[]) => ({ count: 0 }));
const deploymentCreate = vi.fn(async (...a: any[]) => ({ id: "dep-1", ...a[0].data }));

vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: vi.fn(async () => ({ id: "m1", userId: "user-1", organizationId: "org-1", role: "OWNER" })),
    },
    organization: { findUnique: vi.fn(async () => ({ plan: "FREE", planExpiresAt: null })) },
    deployment: {
      updateMany: (...a: any[]) => deploymentUpdateMany(...a),
      create: (...a: any[]) => deploymentCreate(...a),
    },
  },
  ensurePersonalOrg: vi.fn(),
}));

vi.mock("../middleware/plan-limit.middleware", () => ({ isBillingDisabled: () => false }));

import { createCallerFactory } from "../trpc";
import { deploymentRouter } from "../routers/deployment.router";
import { prisma as prismaMock } from "@postautomation/db";

const caller = (opts: { appRole?: string; isSuperAdmin?: boolean } = {}) =>
  createCallerFactory(deploymentRouter)({
    prisma: prismaMock as any,
    organizationId: "org-1",
    session: {
      user: { id: "user-1", email: "a@b.c", isSuperAdmin: opts.isSuperAdmin ?? false, appRole: opts.appRole ?? "ADMIN" },
      expires: "2099-01-01",
    } as any,
  });

const payload = { version: "9.9.9", commitHash: "deadbeef", commitMsg: "forged", branch: "main" };

beforeEach(() => vi.clearAllMocks());

describe("deployment.register", () => {
  it("refuses an ordinary org app-ADMIN (deployments are platform-global, not org-scoped)", async () => {
    await expect(caller({ appRole: "ADMIN", isSuperAdmin: false }).register(payload)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(deploymentCreate).not.toHaveBeenCalled();
    expect(deploymentUpdateMany).not.toHaveBeenCalled();
  });

  it("allows a real super-admin", async () => {
    await expect(caller({ isSuperAdmin: true }).register(payload)).resolves.toMatchObject({ id: "dep-1" });
    expect(deploymentCreate).toHaveBeenCalledTimes(1);
  });
});
