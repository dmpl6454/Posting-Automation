/**
 * Regression guard for bulk.bulkSchedule (fixed 2026-07-27).
 *
 * THE BUG: bulkSchedule updated only the Post row (status SCHEDULED + scheduledAt)
 * and never touched its PostTargets. BulkTab lists DRAFT posts, and post.create
 * writes each target with the POST's status — so those targets were DRAFT. The
 * publish cron selects `targets: { where: { status: "SCHEDULED" } }`
 * (apps/worker/src/scheduler/cron-jobs.ts), which returned an EMPTY list: zero
 * publish jobs were enqueued, the cron still flipped the post to PUBLISHING, and
 * ~45 min later the watchdog reaped it as FAILED. The UI had already said
 * "N post(s) scheduled successfully". Nothing ever published.
 *
 * THE GUARD: the mutation must flip the post's DRAFT/FAILED targets to SCHEDULED,
 * and must NOT touch PUBLISHED/PUBLISHING/CANCELLED targets (re-posting live
 * content would be far worse than the original bug).
 *
 * Also locks the security fix: the bulk procedures are orgProcedure now, so a
 * caller with no OrganizationMember row is rejected before any query runs — they
 * used to be protectedProcedure reading the client's `x-organization-id` header
 * verbatim (cross-org csvExport / bulkDelete).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const postUpdate = vi.fn(async (_args: any) => ({ id: "post-1" }));
const postFindFirst = vi.fn(async (_args: any) => ({ id: "post-1", status: "DRAFT" }));
const postTargetUpdateMany = vi.fn(async (_args: any) => ({ count: 2 }));

vi.mock("@postautomation/db", () => ({
  prisma: {
    post: {
      findFirst: (a: any) => postFindFirst(a),
      update: (a: any) => postUpdate(a),
    },
    postTarget: { updateMany: (a: any) => postTargetUpdateMany(a) },
  },
}));

import { createCallerFactory } from "../trpc";
import { bulkRouter } from "../routers/bulk.router";

const ORG_ID = "org-1";
const USER_ID = "user-1";

function buildCaller(opts: { isMember: boolean }) {
  const prisma = {
    organizationMember: {
      findUnique: vi.fn(async () =>
        opts.isMember ? { userId: USER_ID, organizationId: ORG_ID, role: "OWNER" } : null
      ),
      findFirst: vi.fn(async () =>
        opts.isMember ? { organizationId: ORG_ID } : null
      ),
    },
    organization: {
      findUnique: vi.fn(async () => ({ id: ORG_ID, plan: "FREE", planExpiresAt: null })),
    },
  } as any;

  return createCallerFactory(bulkRouter)({
    session: { user: { id: USER_ID, email: "u@example.com", isSuperAdmin: false } } as any,
    prisma,
    organizationId: ORG_ID,
  } as any);
}

describe("bulk.bulkSchedule — targets must be flipped, not just the post", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flips the post's DRAFT/FAILED targets to SCHEDULED so the publish cron can see them", async () => {
    const caller = buildCaller({ isMember: true });
    const when = "2099-01-01T10:00:00.000Z";

    const res = await caller.bulkSchedule({ items: [{ postId: "post-1", scheduledAt: when }] });

    expect(res.scheduled).toBe(1);
    // The post itself is scheduled…
    expect(postUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "post-1" },
        data: expect.objectContaining({ status: "SCHEDULED" }),
      })
    );
    // …AND its targets (this is the whole fix).
    expect(postTargetUpdateMany).toHaveBeenCalledTimes(1);
    const arg = postTargetUpdateMany.mock.calls[0]![0] as any;
    expect(arg.where.postId).toBe("post-1");
    expect(arg.data.status).toBe("SCHEDULED");
  });

  it("never resurrects PUBLISHED/PUBLISHING/CANCELLED targets", async () => {
    const caller = buildCaller({ isMember: true });
    await caller.bulkSchedule({
      items: [{ postId: "post-1", scheduledAt: "2099-01-01T10:00:00.000Z" }],
    });

    const arg = postTargetUpdateMany.mock.calls[0]![0] as any;
    const allowed: string[] = arg.where.status.in;
    expect(allowed).toEqual(expect.arrayContaining(["DRAFT", "FAILED"]));
    expect(allowed).not.toContain("PUBLISHED");
    expect(allowed).not.toContain("PUBLISHING");
    expect(allowed).not.toContain("CANCELLED");
  });

  it("skips posts that do not belong to the acting org (no target write)", async () => {
    postFindFirst.mockResolvedValueOnce(null as any);
    const caller = buildCaller({ isMember: true });

    const res = await caller.bulkSchedule({
      items: [{ postId: "foreign-post", scheduledAt: "2099-01-01T10:00:00.000Z" }],
    });

    expect(res.scheduled).toBe(0);
    expect(postUpdate).not.toHaveBeenCalled();
    expect(postTargetUpdateMany).not.toHaveBeenCalled();
  });
});

describe("bulk.* org membership enforcement (was a cross-org IDOR)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a caller with no membership in the requested org", async () => {
    const caller = buildCaller({ isMember: false });

    await expect(
      caller.bulkSchedule({ items: [{ postId: "p", scheduledAt: "2099-01-01T10:00:00.000Z" }] })
    ).rejects.toThrow();
    // Crucially: rejected BEFORE any post is touched.
    expect(postUpdate).not.toHaveBeenCalled();
    expect(postTargetUpdateMany).not.toHaveBeenCalled();
  });
});
