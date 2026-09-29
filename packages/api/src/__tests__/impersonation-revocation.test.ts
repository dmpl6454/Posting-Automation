/**
 * Impersonation token was verified purely by HS256 signature + `exp` — for its
 * whole 1-hour lifetime, completely independent of the issuing admin's LIVE
 * status, and with no way to actually revoke it before expiry (security audit
 * 2026-09-28, confirmed by dedicated investigation).
 *
 * Two closed gaps, both in the SAME verification block
 * (packages/api/src/trpc.ts's protectedProcedure):
 *
 *   A) BIND to the issuing admin's live status. `payload.adminUserId` was
 *      signed into the token but never read at verify time. If the admin is
 *      demoted (isSuperAdmin -> false) or banned AFTER minting a token, the
 *      token kept working for the rest of its hour. Now the admin's CURRENT
 *      isSuperAdmin/isBanned is re-checked on every request.
 *   B) REVOCABLE. There was no jti/version check at all — signature +
 *      unexpired was sufficient forever. `User.activeImpersonationJti` is a
 *      single-slot marker: impersonate() writes the new token's jti onto the
 *      admin's own row (auto-invalidating any earlier dangling token from
 *      that same admin — only one live token per admin by construction), and
 *      verification requires payload.jti === admin.activeImpersonationJti.
 *      stopImpersonation nulls it, making "Exit" a REAL server-side kill
 *      switch instead of a client-side cookie delete.
 *
 * stopImpersonation was also moved off superAdminProcedure: since
 * protectedProcedure's swap already downgrades ctx.session.user.isSuperAdmin
 * to false for the SAME request (the swap runs before superAdminProcedure's
 * own gate in the middleware chain), calling it WHILE impersonating always
 * threw FORBIDDEN before the body ever ran — "stop impersonating" was
 * unreachable in its one real use case. It's now protectedProcedure, gated on
 * ctx.isImpersonating === true instead.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SignJWT } from "jose";

process.env.NEXTAUTH_SECRET = "test-secret-32-bytes-long-enough!";
const SECRET = new TextEncoder().encode(process.env.NEXTAUTH_SECRET);

async function signToken(payload: Record<string, unknown>) {
  return new SignJWT(payload).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(SECRET);
}

const userFindUnique = vi.fn();
vi.mock("@postautomation/db", () => ({
  prisma: { user: { findUnique: (a: any) => userFindUnique(a) } },
}));

import { createRouter, protectedProcedure, createCallerFactory } from "../trpc";
import { prisma as prismaMock } from "@postautomation/db";

const whoAmIRouter = createRouter({
  whoAmI: protectedProcedure.query(({ ctx }) => ({
    id: (ctx.session.user as any).id,
    isImpersonating: (ctx as any).isImpersonating,
    adminUserId: (ctx as any).adminUserId,
  })),
});

const ADMIN_SESSION = {
  user: { id: "admin-1", email: "admin@x.com", isSuperAdmin: true, isBanned: false },
  expires: "2099-01-01",
};

function callerWithToken(token: string) {
  return createCallerFactory(whoAmIRouter)({
    prisma: prismaMock as any,
    session: ADMIN_SESSION as any,
    impersonationToken: token,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Two lookups happen per verification attempt: the impersonated target,
  // then the issuing admin (by id). Route by id so both work in one mock.
  userFindUnique.mockImplementation(async (args: any) => {
    const id = args.where.id as string;
    if (id === "target-1") return { id: "target-1", email: "target@x.com", name: "Target", image: null };
    if (id === "admin-1") return { isSuperAdmin: true, isBanned: false, activeImpersonationJti: "jti-current" };
    return null;
  });
});

describe("impersonation verification — bound to the issuing admin's LIVE status", () => {
  it("swaps normally when the admin is still a live, non-banned superadmin with a matching jti", async () => {
    const token = await signToken({ impersonatedUserId: "target-1", adminUserId: "admin-1", jti: "jti-current" });
    const res = await callerWithToken(token).whoAmI();
    expect(res).toMatchObject({ id: "target-1", isImpersonating: true, adminUserId: "admin-1" });
  });

  it("refuses the swap once the issuing admin has been demoted (isSuperAdmin false)", async () => {
    userFindUnique.mockImplementation(async (args: any) => {
      const id = args.where.id as string;
      if (id === "target-1") return { id: "target-1", email: "target@x.com", name: "Target", image: null };
      if (id === "admin-1") return { isSuperAdmin: false, isBanned: false, activeImpersonationJti: "jti-current" };
      return null;
    });
    const token = await signToken({ impersonatedUserId: "target-1", adminUserId: "admin-1", jti: "jti-current" });
    const res = await callerWithToken(token).whoAmI();
    expect(res).toMatchObject({ id: "admin-1", isImpersonating: false });
  });

  it("refuses the swap once the issuing admin has been banned", async () => {
    userFindUnique.mockImplementation(async (args: any) => {
      const id = args.where.id as string;
      if (id === "target-1") return { id: "target-1", email: "target@x.com", name: "Target", image: null };
      if (id === "admin-1") return { isSuperAdmin: true, isBanned: true, activeImpersonationJti: "jti-current" };
      return null;
    });
    const token = await signToken({ impersonatedUserId: "target-1", adminUserId: "admin-1", jti: "jti-current" });
    const res = await callerWithToken(token).whoAmI();
    expect(res).toMatchObject({ id: "admin-1", isImpersonating: false });
  });
});

describe("impersonation verification — revocable via jti", () => {
  it("refuses a token whose jti no longer matches the admin's current active jti (stopped/superseded)", async () => {
    const token = await signToken({ impersonatedUserId: "target-1", adminUserId: "admin-1", jti: "jti-STALE" });
    const res = await callerWithToken(token).whoAmI();
    expect(res).toMatchObject({ id: "admin-1", isImpersonating: false });
  });

  it("refuses a token with no jti at all (pre-fix token shape)", async () => {
    const token = await signToken({ impersonatedUserId: "target-1", adminUserId: "admin-1" });
    const res = await callerWithToken(token).whoAmI();
    expect(res).toMatchObject({ id: "admin-1", isImpersonating: false });
  });

  it("refuses when the admin's activeImpersonationJti has been cleared (stopImpersonation already ran)", async () => {
    userFindUnique.mockImplementation(async (args: any) => {
      const id = args.where.id as string;
      if (id === "target-1") return { id: "target-1", email: "target@x.com", name: "Target", image: null };
      if (id === "admin-1") return { isSuperAdmin: true, isBanned: false, activeImpersonationJti: null };
      return null;
    });
    const token = await signToken({ impersonatedUserId: "target-1", adminUserId: "admin-1", jti: "jti-current" });
    const res = await callerWithToken(token).whoAmI();
    expect(res).toMatchObject({ id: "admin-1", isImpersonating: false });
  });
});
