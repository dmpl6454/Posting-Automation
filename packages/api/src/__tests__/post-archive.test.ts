/**
 * Phase 3 activity management — post.archive / post.unarchive + post.list
 * sort/archived inputs.
 *
 * Invariants locked here:
 *  - Archiving is a VIEW concern (archivedAt column), never a status change,
 *    and is BLOCKED for SCHEDULED/PUBLISHING posts (live pipeline work — the
 *    delayed publish jobs would still fire against an "archived" post).
 *  - Both mutations are org-scoped (cross-org id → NOT_FOUND, no write).
 *  - list defaults reproduce the pre-Phase-3 behavior byte-for-byte:
 *    archivedAt: null filter + createdAt desc ordering.
 *
 * Exercises the REAL router through a caller against a mocked prisma
 * (same harness as post-update-media-block.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../middleware/plan-limit.middleware", () => ({
  enforcePlanLimit: vi.fn(async () => undefined),
  requirePlan: vi.fn(async () => undefined),
  isBillingDisabled: () => false,
}));

vi.mock("@postautomation/queue", () => ({
  pushProgress: vi.fn(async () => {}),
  finishProgress: vi.fn(async () => {}),
  scopedProgressId: (_u: string, p: string) => `scoped:${p}`,
  agentRunQueue: { add: vi.fn(async () => {}) },
  postPublishQueue: { add: vi.fn(async () => {}) },
  enqueueScheduledPublishJobs: vi.fn(async () => 0),
  repurposeVideoQueue: { add: vi.fn(async () => {}) },
}));

const orgMemberFindUnique = vi.fn();
const orgMemberFindFirst = vi.fn();
const orgFindUnique = vi.fn();
const postFindFirst = vi.fn();
const postFindMany = vi.fn();
const postUpdate = vi.fn();
const auditLogCreate = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: (...a: any[]) => orgMemberFindUnique(...a),
      findFirst: (...a: any[]) => orgMemberFindFirst(...a),
    },
    organization: { findUnique: (...a: any[]) => orgFindUnique(...a) },
    post: {
      findFirst: (...a: any[]) => postFindFirst(...a),
      findMany: (...a: any[]) => postFindMany(...a),
      update: (...a: any[]) => postUpdate(...a),
    },
    auditLog: { create: (...a: any[]) => auditLogCreate(...a) },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { postRouter } from "../routers/post.router";
import { prisma as prismaMock } from "@postautomation/db";

const ORG_ID = "org-1";

function makeCaller() {
  const createCaller = createCallerFactory(postRouter);
  return createCaller({
    prisma: prismaMock as any,
    organizationId: ORG_ID,
    session: {
      user: { id: "user-1", email: "boss@example.com", isSuperAdmin: false },
      expires: "2099-01-01",
    } as any,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  orgMemberFindUnique.mockResolvedValue({ id: "m1", userId: "user-1", organizationId: ORG_ID, role: "OWNER" });
  orgMemberFindFirst.mockResolvedValue({ organizationId: ORG_ID });
  orgFindUnique.mockResolvedValue({ plan: "FREE", planExpiresAt: null });
  postUpdate.mockResolvedValue({ id: "p1" });
  postFindMany.mockResolvedValue([]);
});

describe("post.archive", () => {
  it("archives a PUBLISHED post (sets archivedAt)", async () => {
    postFindFirst.mockResolvedValue({ id: "p1", status: "PUBLISHED", archivedAt: null });
    await expect(makeCaller().archive({ id: "p1" })).resolves.toEqual({ success: true });
    expect(postUpdate).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { archivedAt: expect.any(Date) },
    });
  });

  it.each(["SCHEDULED", "PUBLISHING"] as const)(
    "BLOCKS archiving a %s post (live pipeline work in flight)",
    async (status) => {
      postFindFirst.mockResolvedValue({ id: "p1", status, archivedAt: null });
      await expect(makeCaller().archive({ id: "p1" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(postUpdate).not.toHaveBeenCalled();
    }
  );

  it("is idempotent — already-archived post succeeds without a write", async () => {
    postFindFirst.mockResolvedValue({ id: "p1", status: "PUBLISHED", archivedAt: new Date() });
    await expect(makeCaller().archive({ id: "p1" })).resolves.toEqual({ success: true });
    expect(postUpdate).not.toHaveBeenCalled();
  });

  it("org-scopes the lookup — cross-org/unknown id → NOT_FOUND, no write", async () => {
    postFindFirst.mockResolvedValue(null);
    await expect(makeCaller().archive({ id: "other-org-post" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(postFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG_ID }) })
    );
    expect(postUpdate).not.toHaveBeenCalled();
  });
});

describe("post.unarchive", () => {
  it("clears archivedAt", async () => {
    postFindFirst.mockResolvedValue({ id: "p1" });
    await expect(makeCaller().unarchive({ id: "p1" })).resolves.toEqual({ success: true });
    expect(postUpdate).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { archivedAt: null },
    });
  });

  it("org-scopes the lookup — cross-org id → NOT_FOUND, no write", async () => {
    postFindFirst.mockResolvedValue(null);
    await expect(makeCaller().unarchive({ id: "other-org-post" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(postUpdate).not.toHaveBeenCalled();
  });
});

describe("post.list — archived + sort inputs", () => {
  it("defaults reproduce pre-Phase-3 behavior: hides archived, newest first", async () => {
    await makeCaller().list({ limit: 20 });
    const args = postFindMany.mock.calls[0]![0];
    expect(args.where.archivedAt).toBeNull();
    expect(args.orderBy).toEqual({ createdAt: "desc" });
  });

  it("archived:true shows ONLY archived posts", async () => {
    await makeCaller().list({ limit: 20, archived: true });
    const args = postFindMany.mock.calls[0]![0];
    expect(args.where.archivedAt).toEqual({ not: null });
  });

  it("maps sort options to the right orderBy", async () => {
    await makeCaller().list({ limit: 20, sort: "oldest" });
    expect(postFindMany.mock.calls[0]![0].orderBy).toEqual({ createdAt: "asc" });

    await makeCaller().list({ limit: 20, sort: "recently_updated" });
    expect(postFindMany.mock.calls[1]![0].orderBy).toEqual({ updatedAt: "desc" });
  });
});
