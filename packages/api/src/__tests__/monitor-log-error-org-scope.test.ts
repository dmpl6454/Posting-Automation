/**
 * monitor.logError trusted the `x-organization-id` header with no membership
 * check (security audit 2026-09-28).
 *
 * logError is `protectedProcedure`, not `orgProcedure` — it never runs the
 * membership-verification block orgProcedure does. `ctx.organizationId` at
 * that layer is the RAW client header (apps/web/app/api/trpc/[trpc]/route.ts
 * forwards it verbatim). So any signed-in user, regardless of which org they
 * actually belong to, could set that header to an arbitrary org id and:
 *
 *   1. Attribute error rows to a workspace they have no membership in (noise
 *      in that org's Monitoring view for whichever super-admin looks at it).
 *   2. Worse: the dedup lookup matched on `fingerprint` ALONE, with no
 *      organizationId filter — so an identical error message from two
 *      DIFFERENT orgs collided into the SAME row. One org's later `logError`
 *      call would silently overwrite the stored `metadata` of another org's
 *      error and bump ITS occurrence count, corrupting per-tenant data.
 *
 * Fix mirrors the established org.router.ts `current` idiom: the header is
 * honored only when a real OrganizationMember row proves it, exactly like
 * every other org-scoping check in this codebase. An unverified header falls
 * back to no organization (never to guessing a different one) and the dedup
 * lookup is scoped to that same organizationId.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const membershipFindUnique = vi.fn();
const errorLogFindFirst = vi.fn();
const errorLogCreate = vi.fn();
const errorLogUpdate = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: { findUnique: (...a: any[]) => membershipFindUnique(...a) },
    errorLog: {
      findFirst: (...a: any[]) => errorLogFindFirst(...a),
      create: (...a: any[]) => errorLogCreate(...a),
      update: (...a: any[]) => errorLogUpdate(...a),
    },
  },
}));

import { createCallerFactory } from "../trpc";
import { monitorRouter } from "../routers/monitor.router";
import { prisma as prismaMock } from "@postautomation/db";

const caller = (organizationId?: string) =>
  createCallerFactory(monitorRouter)({
    prisma: prismaMock as any,
    organizationId,
    session: { user: { id: "user-1", email: "a@b.c", isSuperAdmin: false }, expires: "2099-01-01" } as any,
  });

beforeEach(() => {
  vi.clearAllMocks();
  errorLogFindFirst.mockResolvedValue(null);
  errorLogCreate.mockImplementation(async (args: any) => ({ id: "err-1", ...args.data }));
});

describe("monitor.logError — header org id must be a real membership", () => {
  it("drops the header org id when the caller is NOT a member of it", async () => {
    membershipFindUnique.mockResolvedValue(null); // not a member of "org-victim"

    await caller("org-victim").logError({ source: "frontend", message: "boom" });

    expect(membershipFindUnique).toHaveBeenCalledWith({
      where: { userId_organizationId: { userId: "user-1", organizationId: "org-victim" } },
    });
    expect(errorLogCreate).toHaveBeenCalledTimes(1);
    expect(errorLogCreate.mock.calls[0]![0].data.organizationId).toBeUndefined();
  });

  it("keeps the header org id when membership is real", async () => {
    membershipFindUnique.mockResolvedValue({ userId: "user-1", organizationId: "org-mine" });

    await caller("org-mine").logError({ source: "frontend", message: "boom" });

    expect(errorLogCreate.mock.calls[0]![0].data.organizationId).toBe("org-mine");
  });

  it("skips the membership lookup entirely when no header is sent", async () => {
    await caller(undefined).logError({ source: "frontend", message: "boom" });

    expect(membershipFindUnique).not.toHaveBeenCalled();
    expect(errorLogCreate.mock.calls[0]![0].data.organizationId).toBeUndefined();
  });

  it("scopes the dedup lookup to the verified organizationId — two orgs' identical messages never collide", async () => {
    membershipFindUnique.mockResolvedValue({ userId: "user-1", organizationId: "org-mine" });

    await caller("org-mine").logError({ source: "frontend", message: "boom" });

    const where = errorLogFindFirst.mock.calls[0]![0].where;
    expect(where.organizationId).toBe("org-mine");
  });
});
