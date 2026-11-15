/**
 * Self-service account deletion (App Store 5.1.1(v); /data-deletion promises
 * it). Locks: password check, impersonation + super-admin refusal, the
 * shared-workspace ownership guard, and EXACTLY which rows are written — a
 * solo workspace's channels lose their tokens and its scheduled posts are
 * cancelled so nothing publishes after the account is gone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("../lib/audit", () => ({
  createAuditLog: vi.fn(async () => {}),
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
}));

// The impersonation swap in protectedProcedure reads the SHARED prisma client
// (not ctx.prisma): mock just that, keep every other export real.
const { sharedFindUnique } = vi.hoisted(() => ({ sharedFindUnique: vi.fn() }));
vi.mock("@postautomation/db", async (orig) => ({ ...(await orig<any>()), prisma: { user: { findUnique: sharedFindUnique } } }));

import { SignJWT } from "jose";
import { createCallerFactory } from "../trpc";
import { userRouter, planAccountDeletion } from "../routers/user.router";

const HASH = bcrypt.hashSync("right-password", 4);

function makePrisma(user: any) {
  const tx = {
    channel: { updateMany: vi.fn(async () => ({ count: 2 })) },
    postTarget: { updateMany: vi.fn(async () => ({ count: 1 })) },
    post: { updateMany: vi.fn(async () => ({ count: 1 })) },
    organizationMember: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    session: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    account: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    user: { update: vi.fn(async () => ({ id: "u1" })) },
  };
  return {
    tx,
    prisma: {
      user: { findUnique: vi.fn(async () => user) },
      $transaction: vi.fn(async (fn: any) => fn(tx)),
    },
  };
}

const solo = { role: "OWNER", organizationId: "o-solo", organization: { name: "Mine", members: [{ userId: "u1", role: "OWNER" }] } };
const sharedOwner = {
  role: "OWNER", organizationId: "o-shared",
  organization: { name: "Agency", members: [{ userId: "u1", role: "OWNER" }, { userId: "u2", role: "MEMBER" }] },
};
const sharedMember = {
  role: "MEMBER", organizationId: "o-team",
  organization: { name: "Team", members: [{ userId: "u1", role: "MEMBER" }, { userId: "u3", role: "OWNER" }] },
};

function caller(prisma: any, opts: { impersonationToken?: string; sessionUserId?: string } = {}) {
  return createCallerFactory(userRouter)({
    prisma,
    session: { user: { id: opts.sessionUserId ?? "u1" } },
    impersonationToken: opts.impersonationToken,
  } as any);
}

/** A real, valid impersonation: admin "admin1" acting as "u1". */
async function impersonation() {
  process.env.NEXTAUTH_SECRET = "test-secret-for-impersonation";
  const token = await new SignJWT({ impersonatedUserId: "u1", adminUserId: "admin1", jti: "j1" })
    .setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.NEXTAUTH_SECRET));
  sharedFindUnique.mockImplementation(async (args: any) =>
    args.where.id === "u1"
      ? { id: "u1", email: "u1@x.io", name: "U", image: null }
      : { isSuperAdmin: true, isBanned: false, activeImpersonationJti: "j1" });
  return token;
}

describe("planAccountDeletion", () => {
  it("closes solo workspaces, leaves shared ones, blocks a sole owner of a shared one", () => {
    expect(planAccountDeletion("u1", [solo, sharedMember] as any)).toEqual({ soloOrgIds: ["o-solo"], leftOrgIds: ["o-team"], blockedBy: [] });
    expect(planAccountDeletion("u1", [sharedOwner] as any).blockedBy).toEqual(["Agency"]);
  });
  it("a co-owned workspace does not block", () => {
    const coOwned = { ...sharedOwner, organization: { name: "Agency", members: [{ userId: "u1", role: "OWNER" }, { userId: "u2", role: "OWNER" }] } };
    expect(planAccountDeletion("u1", [coOwned] as any)).toEqual({ soloOrgIds: [], leftOrgIds: ["o-shared"], blockedBy: [] });
  });
});

describe("user.deleteAccount", () => {
  let user: any;
  beforeEach(() => {
    user = { password: HASH, isSuperAdmin: false, deletedAt: null, memberships: [solo, sharedMember] };
  });

  it("requires the confirmation word", async () => {
    const { prisma } = makePrisma(user);
    await expect(caller(prisma).deleteAccount({ password: "right-password", confirm: "delete" } as any)).rejects.toThrow();
  });

  it("rejects a wrong or missing password and writes nothing", async () => {
    const { prisma, tx } = makePrisma(user);
    await expect(caller(prisma).deleteAccount({ password: "nope", confirm: "DELETE" })).rejects.toThrow(/Password is incorrect/);
    await expect(caller(prisma).deleteAccount({ confirm: "DELETE" })).rejects.toThrow(/Password is incorrect/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("refuses while impersonating and for super admins", async () => {
    const a = makePrisma(user);
    const token = await impersonation();
    await expect(
      caller(a.prisma, { impersonationToken: token, sessionUserId: "admin1" }).deleteAccount({ password: "right-password", confirm: "DELETE" }),
    ).rejects.toThrow(/impersonating/);
    expect(sharedFindUnique).toHaveBeenCalled(); // the swap really ran
    expect(a.prisma.$transaction).not.toHaveBeenCalled();
    const b = makePrisma({ ...user, isSuperAdmin: true });
    await expect(caller(b.prisma).deleteAccount({ password: "right-password", confirm: "DELETE" })).rejects.toThrow(/Super admin/);
  });

  it("refuses when it would leave a shared workspace without an owner", async () => {
    const { prisma } = makePrisma({ ...user, memberships: [sharedOwner] });
    await expect(caller(prisma).deleteAccount({ password: "right-password", confirm: "DELETE" })).rejects.toThrow(/Transfer ownership of Agency/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("disconnects + cancels only in solo workspaces, then wipes the account", async () => {
    const { prisma, tx } = makePrisma(user);
    const r = await caller(prisma).deleteAccount({ password: "right-password", confirm: "DELETE" });
    expect(r).toEqual({ success: true, workspacesClosed: 1 });

    const ch = (tx.channel.updateMany.mock.calls as any[])[0][0];
    expect(ch.where.organizationId).toEqual({ in: ["o-solo"] });
    expect(ch.data).toMatchObject({ isActive: false, accessToken: "disconnected", refreshToken: null });
    expect((tx.postTarget.updateMany.mock.calls as any[])[0][0]).toEqual({
      where: { post: { organizationId: { in: ["o-solo"] } }, status: "SCHEDULED" }, data: { status: "CANCELLED" },
    });
    expect((tx.post.updateMany.mock.calls as any[])[0][0].where).toEqual({ organizationId: { in: ["o-solo"] }, status: "SCHEDULED" });

    expect((tx.organizationMember.deleteMany.mock.calls as any[])[0][0]).toEqual({ where: { userId: "u1" } });
    expect((tx.session.deleteMany.mock.calls as any[])[0][0]).toEqual({ where: { userId: "u1" } });
    const upd = (tx.user.update.mock.calls as any[])[0][0];
    expect(upd.where).toEqual({ id: "u1" });
    expect(upd.data).toMatchObject({ email: "deleted-u1@deleted.invalid", name: null, password: null, phone: null });
    expect(upd.data.deletedAt).toBeInstanceOf(Date);
  });

  it("an OAuth-only user (no password) can delete with the confirmation word alone", async () => {
    const { prisma, tx } = makePrisma({ ...user, password: null, memberships: [sharedMember] });
    await caller(prisma).deleteAccount({ confirm: "DELETE" });
    expect(tx.channel.updateMany).not.toHaveBeenCalled(); // no solo workspace
    expect(tx.user.update).toHaveBeenCalled();
  });
});
