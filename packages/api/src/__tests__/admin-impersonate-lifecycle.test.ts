/**
 * impersonate/stopImpersonation revocation lifecycle (security audit
 * 2026-09-28 — see impersonation-revocation.test.ts for the verification-side
 * coverage of the same fix).
 *
 * impersonate() now mints a `jti` and writes it onto the admin's OWN row as
 * `activeImpersonationJti` (a single-slot marker — the next impersonate()
 * overwrites it, auto-invalidating any earlier dangling token from the same
 * admin). stopImpersonation nulls that slot, which is what makes it an actual
 * server-side kill switch rather than a client-side cookie delete.
 *
 * stopImpersonation also moved off superAdminProcedure: since
 * protectedProcedure's session swap runs BEFORE superAdminProcedure's own
 * gate in the middleware chain, calling it WHILE impersonating (ctx.session
 * .user.isSuperAdmin is now false — the impersonated ordinary user) always
 * threw FORBIDDEN before its body ever ran. It's now protectedProcedure,
 * gated on ctx.isImpersonating === true — reachable in its one real use case.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { jwtVerify, SignJWT } from "jose";

process.env.NEXTAUTH_SECRET = "test-secret-32-bytes-long-enough!";

const userFindUnique = vi.fn();
const userUpdate = vi.fn(async (args: any) => ({ id: args.where.id, ...args.data }));
const auditLogCreate = vi.fn(async (..._a: any[]) => ({}));

vi.mock("@postautomation/db", () => ({
  prisma: {
    user: {
      findUnique: (a: any) => userFindUnique(a),
      update: (a: any) => userUpdate(a),
    },
    auditLog: { create: (a: any) => auditLogCreate(a) },
  },
}));

import { createCallerFactory } from "../trpc";
import { adminUsersRouter } from "../routers/admin/users.router";
import { prisma as prismaMock } from "@postautomation/db";

const ADMIN_ID = "admin-1";
const TARGET_ID = "target-1";

function superAdminCaller() {
  return createCallerFactory(adminUsersRouter)({
    prisma: prismaMock as any,
    session: { user: { id: ADMIN_ID, email: "admin@x.com", isSuperAdmin: true, isBanned: false }, expires: "2099-01-01" } as any,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  userFindUnique.mockImplementation(async (args: any) => {
    const id = args.where.id as string;
    if (id === TARGET_ID) return { id: TARGET_ID, isSuperAdmin: false };
    if (id === ADMIN_ID) return { id: ADMIN_ID, isSuperAdmin: true, isBanned: false };
    return null;
  });
});

describe("admin.users.impersonate — mints a revocable jti", () => {
  it("signs a token whose jti matches what it writes onto the admin's own row", async () => {
    const { token } = await superAdminCaller().impersonate({ userId: TARGET_ID });

    expect(userUpdate).toHaveBeenCalledTimes(1);
    const updateArgs = userUpdate.mock.calls[0]![0];
    expect(updateArgs.where.id).toBe(ADMIN_ID);
    const writtenJti = updateArgs.data.activeImpersonationJti as string;
    expect(writtenJti).toBeTruthy();

    const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET);
    const { payload } = await jwtVerify(token, secret);
    expect(payload.jti).toBe(writtenJti);
    expect(payload.impersonatedUserId).toBe(TARGET_ID);
    expect(payload.adminUserId).toBe(ADMIN_ID);
  });

  it("still refuses to impersonate a super admin", async () => {
    userFindUnique.mockImplementation(async (args: any) =>
      args.where.id === TARGET_ID ? { id: TARGET_ID, isSuperAdmin: true } : null
    );
    await expect(superAdminCaller().impersonate({ userId: TARGET_ID })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(userUpdate).not.toHaveBeenCalled();
  });
});

describe("admin.users.stopImpersonation — a real server-side kill switch", () => {
  it("clears the admin's activeImpersonationJti and is reachable WHILE impersonating", async () => {
    // Mirrors production: the acting session IS the impersonated (ordinary,
    // non-superadmin) user — protectedProcedure's swap already happened.
    // ctx.isImpersonating/adminUserId are what that swap actually produces.
    // ctx.isImpersonating/adminUserId are NOT trustworthy as raw caller
    // input — protectedProcedure's own middleware resets both to
    // false/undefined at the top of every request and only sets them for
    // real via a successfully-verified impersonationToken (trpc.ts). So to
    // get an authentic ctx here the test goes through that real flow, exactly
    // as production does, rather than injecting the ctx fields directly.
    userFindUnique.mockImplementation(async (args: any) => {
      const id = args.where.id as string;
      if (id === TARGET_ID) return { id: TARGET_ID, email: "target@x.com", name: "Target", image: null };
      if (id === ADMIN_ID) return { isSuperAdmin: true, isBanned: false, activeImpersonationJti: "jti-live" };
      return null;
    });
    const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET);
    const impersonationToken = await new SignJWT({ impersonatedUserId: TARGET_ID, adminUserId: ADMIN_ID })
      .setProtectedHeader({ alg: "HS256" })
      .setJti("jti-live")
      .setExpirationTime("1h")
      .sign(secret);

    const caller = createCallerFactory(adminUsersRouter)({
      prisma: prismaMock as any,
      // The un-swapped acting session — protectedProcedure performs the swap.
      session: { user: { id: ADMIN_ID, email: "admin@x.com", isSuperAdmin: true, isBanned: false }, expires: "2099-01-01" } as any,
      impersonationToken,
    } as any);

    const res = await caller.stopImpersonation();
    expect(res).toEqual({ success: true });
    expect(userUpdate).toHaveBeenCalledWith({ where: { id: ADMIN_ID }, data: { activeImpersonationJti: null } });
  });

  // Idempotent when no swap happened (no token, superseded jti, demoted admin,
  // expired token, a stale second tab): it must SUCCEED so the client can
  // clear its cookie instead of stranding the banner — but it must not clear
  // anyone's slot (no free-standing revoke-anyone primitive).
  it("succeeds without clearing any slot when there is no impersonation token", async () => {
    const caller = createCallerFactory(adminUsersRouter)({
      prisma: prismaMock as any,
      session: { user: { id: ADMIN_ID, email: "admin@x.com", isSuperAdmin: true, isBanned: false }, expires: "2099-01-01" } as any,
    } as any);

    await expect(caller.stopImpersonation()).resolves.toEqual({ success: true });
    expect(userUpdate).not.toHaveBeenCalled();
    expect(auditLogCreate).not.toHaveBeenCalled();
  });

  it("succeeds without clearing when the presented token is superseded (stale second tab)", async () => {
    userFindUnique.mockImplementation(async (args: any) => {
      const id = args.where.id as string;
      if (id === TARGET_ID) return { id: TARGET_ID, email: "target@x.com", name: "Target", image: null };
      if (id === ADMIN_ID) return { isSuperAdmin: true, isBanned: false, activeImpersonationJti: "jti-NEWER" };
      return null;
    });
    const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET);
    const impersonationToken = await new SignJWT({ impersonatedUserId: TARGET_ID, adminUserId: ADMIN_ID })
      .setProtectedHeader({ alg: "HS256" })
      .setJti("jti-OLD")
      .setExpirationTime("1h")
      .sign(secret);

    const caller = createCallerFactory(adminUsersRouter)({
      prisma: prismaMock as any,
      session: { user: { id: ADMIN_ID, email: "admin@x.com", isSuperAdmin: true, isBanned: false }, expires: "2099-01-01" } as any,
      impersonationToken,
    } as any);

    await expect(caller.stopImpersonation()).resolves.toEqual({ success: true });
    // The newer, live session from another tab must survive.
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("a DIFFERENT account presenting the admin's token clears nothing", async () => {
    userFindUnique.mockImplementation(async (args: any) => {
      const id = args.where.id as string;
      if (id === TARGET_ID) return { id: TARGET_ID, email: "target@x.com", name: "Target", image: null };
      if (id === ADMIN_ID) return { isSuperAdmin: true, isBanned: false, activeImpersonationJti: "jti-live" };
      return null;
    });
    const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET);
    const impersonationToken = await new SignJWT({ impersonatedUserId: TARGET_ID, adminUserId: ADMIN_ID })
      .setProtectedHeader({ alg: "HS256" })
      .setJti("jti-live")
      .setExpirationTime("1h")
      .sign(secret);

    const caller = createCallerFactory(adminUsersRouter)({
      prisma: prismaMock as any,
      session: { user: { id: "user-2", email: "u2@x.com", isSuperAdmin: false, isBanned: false }, expires: "2099-01-01" } as any,
      impersonationToken,
    } as any);

    await expect(caller.stopImpersonation()).resolves.toEqual({ success: true });
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
