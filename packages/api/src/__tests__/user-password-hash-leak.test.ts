/**
 * No procedure may return a User row's password hash (or the impersonation
 * revocation marker) to a browser (found 2026-10-02).
 *
 * user.updateProfile returned the caller's full row, hash included, and three
 * super-admin procedures (admin.users.getById, toggleSuperAdmin, toggleBan)
 * returned OTHER users' full rows — every user's hash was one admin click from
 * a browser. They now select PUBLIC_USER_SELECT.
 *
 * The prisma mock behaves like Prisma: with a `select` it returns only those
 * fields, without one it returns the whole row — so a procedure that forgets
 * the select fails here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/audit", () => ({
  createAuditLog: vi.fn(async () => {}),
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
}));

const FULL_ROW = {
  id: "u2",
  name: "Target",
  email: "t@example.com",
  emailVerified: null,
  image: null,
  password: "$2a$12$abcdefghijklmnopqrstuuCHASHHASHHASHHASHHASHHASHHASHH",
  passwordChangedAt: new Date("2026-01-01"),
  isSuperAdmin: false,
  appRole: "USER",
  isBanned: false,
  phone: null,
  phoneVerified: null,
  deletedAt: null,
  activeImpersonationJti: "jti-secret",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-02"),
  memberships: [{ id: "m1", role: "OWNER", organization: { id: "o1", name: "Org", slug: "org", plan: "FREE" } }],
};

function applySelect(select: Record<string, unknown> | undefined) {
  if (!select) return { ...FULL_ROW };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(select)) if (select[k]) out[k] = (FULL_ROW as any)[k];
  return out;
}
const userUpdate = vi.fn(async (args: any) => applySelect(args?.select));
const userFindUnique = vi.fn(async (args: any): Promise<any> =>
  // The guard lookups select one flag; getById is the call that returns a row.
  args?.select && Object.keys(args.select).length === 1 ? { [Object.keys(args.select)[0]!]: false } : applySelect(args?.select),
);
const prisma = {
  user: { update: userUpdate, findUnique: userFindUnique, count: vi.fn(async () => 2) },
};

import { createCallerFactory } from "../trpc";
import { userRouter } from "../routers/user.router";
import { adminUsersRouter } from "../routers/admin/users.router";

const session = (isSuperAdmin: boolean) =>
  ({ user: { id: "u1", email: "a@b.c", isSuperAdmin, appRole: "ADMIN" }, expires: "2099-01-01" }) as any;
const userCaller = () => createCallerFactory(userRouter)({ prisma: prisma as any, organizationId: "o1", session: session(false) });
const adminCaller = () => createCallerFactory(adminUsersRouter)({ prisma: prisma as any, organizationId: "o1", session: session(true) });

const SECRET_KEYS = ["password", "activeImpersonationJti", "passwordChangedAt"];
function expectNoSecrets(value: unknown) {
  const json = JSON.stringify(value);
  for (const k of SECRET_KEYS) expect(json, k).not.toContain(`"${k}"`);
  expect(json).not.toContain("$2a$12$");
}

beforeEach(() => vi.clearAllMocks());

describe("no password hash reaches the browser", () => {
  it("user.me keeps every field the apps read and drops the internal ones", async () => {
    userFindUnique.mockResolvedValueOnce({ ...FULL_ROW });
    const r: any = await userCaller().me();
    expectNoSecrets(r);
    // apps/ios Models/User.swift decodes these; removing one breaks installed builds.
    expect(r).toMatchObject({ id: "u2", email: "t@example.com", name: "Target", isSuperAdmin: false, appRole: "USER", hasPassword: true });
    expect(r.memberships).toHaveLength(1);
  });

  it("user.updateProfile returns the profile without the hash", async () => {
    const r = await userCaller().updateProfile({ name: "New" });
    expectNoSecrets(r);
    expect(r).toMatchObject({ id: "u2", name: "Target" }); // the settings page reads `name`
  });

  it("admin.users.getById returns the user and memberships without the hash", async () => {
    const r = await adminCaller().getById({ id: "u2" });
    expectNoSecrets(r);
    expect(r).toMatchObject({ id: "u2", email: "t@example.com", memberships: [{ organization: { slug: "org" } }] });
  });

  it("admin.users.toggleSuperAdmin returns the user without the hash", async () => {
    const r = await adminCaller().toggleSuperAdmin({ userId: "u2" });
    expectNoSecrets(r);
    expect(r).toHaveProperty("isSuperAdmin");
  });

  it("admin.users.toggleBan returns the user without the hash", async () => {
    const r = await adminCaller().toggleBan({ userId: "u2" });
    expectNoSecrets(r);
    expect(r).toHaveProperty("isBanned");
  });
});
