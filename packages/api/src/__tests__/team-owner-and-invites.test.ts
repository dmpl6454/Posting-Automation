/**
 * Two team.router gaps from the security audit (2026-09-28):
 *
 * 1. `updateRole` could demote the org's OWNER via the ordinary role-change
 *    form. Its input only accepts `role: "ADMIN" | "MEMBER"` (no way to name
 *    a NEW owner), so this always strictly LOSES the org's owner — an org
 *    with zero OWNER rows breaks every place that assumes one exists:
 *    `removeMember`'s "cannot remove the owner" guard becomes moot (nothing
 *    is left to protect), `transferOwnership` has no OWNER membership to
 *    demote, and billing/ownership-only actions become unreachable for
 *    everyone. The real remedy already exists (`transferOwnership`, which
 *    keeps exactly one OWNER at all times) — `updateRole` must refuse to
 *    touch an OWNER's role at all, not just when the target is the CALLER.
 *
 * 2. A pending email invite (`OrganizationInvite`, no matching user yet)
 *    could never be revoked. If it was sent to the wrong address, or the
 *    inviting admin is later removed, or an org wants to lock someone out
 *    before they sign up, the token stays valid until it expires (7 days)
 *    with no way to shorten that. `team.revokeInvite` + `team.listInvites`
 *    close it, gated the same way `invite` is (OWNER/ADMIN via
 *    adminOrgProcedure) and org-scoped so one workspace can never revoke
 *    another's invite by guessing/enumerating an invite id.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/audit", () => ({
  createAuditLog: vi.fn(async () => ({})),
  AUDIT_ACTIONS: {
    MEMBER_INVITED: "member.invited",
    MEMBER_ROLE_CHANGED: "member.role_changed",
    MEMBER_REMOVED: "member.removed",
    INVITE_REVOKED: "invite.revoked",
  },
}));
vi.mock("../lib/email", () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock("../middleware/plan-limit.middleware", () => ({
  enforcePlanLimit: vi.fn(async () => undefined),
  isBillingDisabled: () => false,
}));

const memberFindFirst = vi.fn();
const memberUpdate = vi.fn();
const inviteFindFirst = vi.fn();
const inviteFindMany = vi.fn();
const inviteDelete = vi.fn();
const inviteCount = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: vi.fn(async () => ({ id: "m-caller", userId: "user-1", organizationId: "org-1", role: "OWNER" })),
      findFirst: (...a: any[]) => memberFindFirst(...a),
      update: (...a: any[]) => memberUpdate(...a),
      count: (...a: any[]) => inviteCount(...a), // unused by these tests; keeps shape complete
    },
    organization: { findUnique: vi.fn(async () => ({ plan: "FREE", planExpiresAt: null, name: "Acme" })) },
    organizationInvite: {
      findFirst: (...a: any[]) => inviteFindFirst(...a),
      findMany: (...a: any[]) => inviteFindMany(...a),
      delete: (...a: any[]) => inviteDelete(...a),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { teamRouter } from "../routers/team.router";
import { prisma as prismaMock } from "@postautomation/db";

const caller = (role: "OWNER" | "ADMIN" | "MEMBER" = "OWNER") =>
  createCallerFactory(teamRouter)({
    prisma: { ...prismaMock, organizationMember: { ...prismaMock.organizationMember, findUnique: vi.fn(async () => ({ id: "m-caller", userId: "user-1", organizationId: "org-1", role })) } } as any,
    organizationId: "org-1",
    // appRole: "ADMIN" clears the adminOrgProcedure app-role gate (a DIFFERENT
    // axis from the org `role` under test here — see isAppAdmin in trpc.ts).
    session: { user: { id: "user-1", email: "a@b.c", isSuperAdmin: false, appRole: "ADMIN" }, expires: "2099-01-01" } as any,
  });

beforeEach(() => {
  vi.clearAllMocks();
  memberUpdate.mockImplementation(async (args: any) => ({ id: args.where.id, ...args.data }));
});

describe("team.updateRole — must never leave the org without an OWNER", () => {
  it("refuses to change the OWNER's own role (self-demotion)", async () => {
    memberFindFirst.mockResolvedValue({ id: "m-caller", organizationId: "org-1", role: "OWNER" });
    await expect(caller("OWNER").updateRole({ memberId: "m-caller", role: "ADMIN" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(memberUpdate).not.toHaveBeenCalled();
  });

  it("refuses to change ANY owner's role, not just the caller's own", async () => {
    memberFindFirst.mockResolvedValue({ id: "m-other-owner", organizationId: "org-1", role: "OWNER" });
    await expect(caller("OWNER").updateRole({ memberId: "m-other-owner", role: "MEMBER" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(memberUpdate).not.toHaveBeenCalled();
  });

  it("still allows the ordinary ADMIN <-> MEMBER role change", async () => {
    memberFindFirst.mockResolvedValue({ id: "m-2", organizationId: "org-1", role: "MEMBER" });
    await expect(caller("OWNER").updateRole({ memberId: "m-2", role: "ADMIN" })).resolves.toMatchObject({
      id: "m-2",
      role: "ADMIN",
    });
    expect(memberUpdate).toHaveBeenCalledTimes(1);
  });

  it("non-owners still cannot change roles at all", async () => {
    memberFindFirst.mockResolvedValue({ id: "m-2", organizationId: "org-1", role: "MEMBER" });
    await expect(caller("ADMIN").updateRole({ memberId: "m-2", role: "ADMIN" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("team.listInvites / team.revokeInvite", () => {
  it("lists only this org's pending (unaccepted, unexpired) invites", async () => {
    inviteFindMany.mockResolvedValue([{ id: "inv-1", email: "x@y.com", role: "MEMBER" }]);
    const res = await caller("OWNER").listInvites();
    expect(res).toEqual([{ id: "inv-1", email: "x@y.com", role: "MEMBER" }]);
    const args = inviteFindMany.mock.calls[0]![0];
    expect(args.where).toMatchObject({ organizationId: "org-1", acceptedAt: null });
  });

  it("revokes a pending invite that belongs to this org", async () => {
    inviteFindFirst.mockResolvedValue({ id: "inv-1", organizationId: "org-1", email: "x@y.com", acceptedAt: null });
    await expect(caller("OWNER").revokeInvite({ inviteId: "inv-1" })).resolves.toEqual({ success: true });
    expect(inviteDelete).toHaveBeenCalledWith({ where: { id: "inv-1" } });
  });

  it("is org-scoped: cannot revoke another workspace's invite", async () => {
    inviteFindFirst.mockResolvedValue(null); // findFirst is called WITH organizationId in its where, so a foreign invite never matches
    await expect(caller("OWNER").revokeInvite({ inviteId: "inv-foreign" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(inviteDelete).not.toHaveBeenCalled();
    expect(inviteFindFirst.mock.calls[0]![0].where).toMatchObject({ id: "inv-foreign", organizationId: "org-1" });
  });

  it("ADMIN (not just OWNER) can list and revoke, matching the invite gate", async () => {
    inviteFindMany.mockResolvedValue([{ id: "inv-1", email: "x@y.com", role: "MEMBER" }]);
    await expect(caller("ADMIN").listInvites()).resolves.toEqual([{ id: "inv-1", email: "x@y.com", role: "MEMBER" }]);
    inviteFindFirst.mockResolvedValue({ id: "inv-1", organizationId: "org-1", email: "x@y.com", acceptedAt: null });
    await expect(caller("ADMIN").revokeInvite({ inviteId: "inv-1" })).resolves.toEqual({ success: true });
  });

  // adminOrgProcedure only checks the APP role (User.appRole); a plain org
  // MEMBER with an app-admin account must not read pending invite emails.
  it("an org MEMBER cannot list invites (same org-role gate as invite/revokeInvite)", async () => {
    inviteFindMany.mockResolvedValue([{ id: "inv-1", email: "x@y.com", role: "MEMBER" }]);
    await expect(caller("MEMBER").listInvites()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(inviteFindMany).not.toHaveBeenCalled();
  });

  it("an org MEMBER cannot revoke an invite", async () => {
    inviteFindFirst.mockResolvedValue({ id: "inv-1", organizationId: "org-1", email: "x@y.com", acceptedAt: null });
    await expect(caller("MEMBER").revokeInvite({ inviteId: "inv-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(inviteDelete).not.toHaveBeenCalled();
  });
});
