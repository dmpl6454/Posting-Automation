/**
 * bulk.bulkUpdateStatus must actually STOP a queued publish, not just relabel
 * the post (security audit 2026-09-28, confirmed medium).
 *
 * post.create/update enqueue per-target DELAYED BullMQ jobs at save time
 * (packages/queue/src/schedule-publish.ts, jobId sched:{targetId}:{epoch}).
 * The worker's pre-claim guard, isStaleScheduleJob, skips one of those jobs
 * ONLY when the post's CURRENT scheduledAt no longer matches the value it was
 * enqueued with (apps/worker/src/lib/publish-recovery.ts). bulkUpdateStatus
 * changed Post.status alone and never touched scheduledAt, so a post the
 * operator had just clicked "Cancel" or "Move to Draft" on kept its original
 * scheduledAt and published on schedule anyway — the status change was purely
 * cosmetic against an already-queued job.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const postFindMany = vi.fn();
const postUpdateMany = vi.fn(async (_args: any) => ({ count: 1 }));
const postTargetUpdateMany = vi.fn(async (_args: any) => ({ count: 1 }));

vi.mock("@postautomation/db", () => ({
  prisma: {
    post: { findMany: (a: any) => postFindMany(a), updateMany: (a: any) => postUpdateMany(a) },
    postTarget: { updateMany: (a: any) => postTargetUpdateMany(a) },
  },
}));

import { createCallerFactory } from "../trpc";
import { bulkRouter } from "../routers/bulk.router";

const ORG_ID = "org-1";

function buildCaller() {
  const prisma = {
    organizationMember: { findUnique: vi.fn(async () => ({ userId: "u1", organizationId: ORG_ID, role: "OWNER" })) },
    organization: { findUnique: vi.fn(async () => ({ id: ORG_ID, plan: "FREE", planExpiresAt: null })) },
  } as any;
  return createCallerFactory(bulkRouter)({
    session: { user: { id: "u1", email: "u@example.com", isSuperAdmin: false } } as any,
    prisma,
    organizationId: ORG_ID,
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  postFindMany.mockResolvedValue([{ id: "post-1" }]);
});

describe("bulk.bulkUpdateStatus", () => {
  it("clears scheduledAt so any already-queued delayed publish job goes stale", async () => {
    await buildCaller().bulkUpdateStatus({ postIds: ["post-1"], status: "CANCELLED" });

    expect(postUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CANCELLED", scheduledAt: null }),
      })
    );
  });

  it("flips the post's own claimable targets, never leaving them SCHEDULED under a cancelled post", async () => {
    await buildCaller().bulkUpdateStatus({ postIds: ["post-1"], status: "CANCELLED" });

    expect(postTargetUpdateMany).toHaveBeenCalledTimes(1);
    const arg = postTargetUpdateMany.mock.calls[0]![0];
    expect(arg.where.postId).toEqual({ in: ["post-1"] });
    expect(arg.where.status).toEqual({ in: ["SCHEDULED", "DRAFT", "FAILED"] });
    expect(arg.data.status).toBe("CANCELLED");
  });

  it("never touches a target whose publish outcome is unknown (ambiguousAt set) — that is a separate human decision", async () => {
    await buildCaller().bulkUpdateStatus({ postIds: ["post-1"], status: "CANCELLED" });
    const arg = postTargetUpdateMany.mock.calls[0]![0];
    expect(arg.where.ambiguousAt).toBe(null);
  });

  it("EXCLUDES a post that is already PUBLISHED — never rewrite a completed post's status", async () => {
    postFindMany.mockResolvedValue([]); // findMany's own where filters PUBLISHED out
    const res = await buildCaller().bulkUpdateStatus({ postIds: ["post-1"], status: "DRAFT" });

    expect(res.updated).toBe(0);
    expect(postUpdateMany).not.toHaveBeenCalled();
    expect(postTargetUpdateMany).not.toHaveBeenCalled();
    // The eligibility query itself must exclude PUBLISHED/PUBLISHING.
    expect(postFindMany.mock.calls[0]![0].where.status).toEqual({ notIn: ["PUBLISHED", "PUBLISHING"] });
  });

  it("EXCLUDES a post that is mid-flight PUBLISHING — must never be disturbed", async () => {
    postFindMany.mockResolvedValue([]);
    await buildCaller().bulkUpdateStatus({ postIds: ["post-1"], status: "CANCELLED" });
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it("scopes both writes to only the ELIGIBLE ids, even when other ids in the batch were excluded", async () => {
    postFindMany.mockResolvedValue([{ id: "post-1" }]); // post-2 was filtered out by the eligibility query
    await buildCaller().bulkUpdateStatus({ postIds: ["post-1", "post-2"], status: "DRAFT" });

    expect(postUpdateMany.mock.calls[0]![0].where.id).toEqual({ in: ["post-1"] });
    expect(postTargetUpdateMany.mock.calls[0]![0].where.postId).toEqual({ in: ["post-1"] });
  });

  it("is org-scoped in the eligibility query itself", async () => {
    await buildCaller().bulkUpdateStatus({ postIds: ["post-1"], status: "DRAFT" });
    expect(postFindMany.mock.calls[0]![0].where.organizationId).toBe(ORG_ID);
  });
});
