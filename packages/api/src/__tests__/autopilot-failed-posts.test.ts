/**
 * autopilot.failedPosts (AP-01) — surfaces AutopilotPost rows whose content
 * generation FAILED so a user whose autopilot silently stops posting can see
 * why, instead of Review Queue / Posts staying empty with no signal.
 *
 * Background: generation failures ARE persisted (AutopilotPost.status="FAILED"
 * + errorMessage, PipelineRun.postsFailed incremented) but there was no read
 * path — reviewQueue hard-filters to status:"REVIEWING" and posts requires an
 * existing Post row (never created when generation fails before a Post exists).
 *
 * These exercise the REAL autopilotRouter through a tRPC caller with a fully
 * mocked prisma, mirroring the harness in campaign-set-monitoring.test.ts:
 * organizationMember.findUnique backs orgProcedure's membership gate, and the
 * actor is a superadmin so the planExpiresAt revert branch in orgProcedure is
 * skipped without needing an organization.findUnique mock.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// autopilotRouter transitively imports @postautomation/queue (BullMQ/Redis at
// import time). failedPosts/overview never touch a queue, so stub it to stay
// offline, mirroring other router tests in this suite.
vi.mock("@postautomation/queue", () => ({
  autopilotScheduleQueue: { add: vi.fn() },
  trendDiscoverQueue: { add: vi.fn() },
  createRedisConnection: vi.fn(),
}));

vi.mock("../middleware/plan-limit.middleware", () => ({
  requirePlan: vi.fn(async () => {}),
}));

import { createCallerFactory } from "../trpc";
import { autopilotRouter } from "../routers/autopilot.router";

const ORG_ID = "org-1";
const OTHER_ORG_ID = "org-2";
const USER_ID = "user-1";

function baseMembership() {
  return {
    organizationMember: {
      findUnique: vi.fn(async () => ({ userId: USER_ID, organizationId: ORG_ID, role: "OWNER" })),
    },
  };
}

function session() {
  return { user: { id: USER_ID, email: "u@example.com", isSuperAdmin: true } } as any;
}

describe("autopilot.failedPosts", () => {
  beforeEach(() => vi.clearAllMocks());

  function buildCaller(rows: any[]) {
    const findMany = vi.fn(async (_args: any) => rows);
    const prisma = {
      ...baseMembership(),
      autopilotPost: { findMany },
    } as any;
    const caller = createCallerFactory(autopilotRouter)({
      prisma,
      session: session(),
      organizationId: ORG_ID,
    });
    return { caller, findMany };
  }

  it("queries autopilotPost.findMany scoped to the org + status FAILED, newest first", async () => {
    const { caller, findMany } = buildCaller([]);
    await caller.failedPosts({});

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0]![0]!;
    expect(arg.where).toEqual({ organizationId: ORG_ID, status: "FAILED" });
    expect(arg.orderBy).toEqual({ createdAt: "desc" });
  });

  it("includes the related agent name and trending item title, plus errorMessage", async () => {
    const rows = [
      {
        id: "ap-1",
        organizationId: ORG_ID,
        status: "FAILED",
        errorMessage: "Missing AI API key",
        agent: { name: "Daily Tech Digest" },
        trendingItem: { title: "AI breakthrough announced" },
        createdAt: new Date("2026-07-09T00:00:00Z"),
      },
    ];
    const { caller } = buildCaller(rows);
    const res = await caller.failedPosts({});

    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      errorMessage: "Missing AI API key",
      agent: { name: "Daily Tech Digest" },
      trendingItem: { title: "AI breakthrough announced" },
    });
  });

  it("respects the limit input (default 30, capped 100)", async () => {
    const { caller, findMany } = buildCaller([]);
    await caller.failedPosts({ limit: 10 });
    expect(findMany.mock.calls[0]![0]!.take).toBe(10);

    await caller.failedPosts({});
    expect(findMany.mock.calls[1]![0]!.take).toBe(30);
  });

  it("is unreachable without a valid org membership (same guard as reviewQueue)", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = {
      organizationMember: { findUnique: vi.fn(async () => null) },
      autopilotPost: { findMany },
    } as any;
    const caller = createCallerFactory(autopilotRouter)({
      prisma,
      session: session(),
      organizationId: OTHER_ORG_ID,
    });

    await expect(caller.failedPosts({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("autopilot.overview includes failedCount", () => {
  beforeEach(() => vi.clearAllMocks());

  function buildCaller(counts: { trending: number; reviewing: number; today: number; failed: number }) {
    const trendingItemCount = vi.fn(async () => counts.trending);
    const autopilotPostCount = vi
      .fn()
      .mockResolvedValueOnce(counts.reviewing)
      .mockResolvedValueOnce(counts.today)
      .mockResolvedValueOnce(counts.failed);
    const pipelineRunFindFirst = vi.fn(async () => null);
    const prisma = {
      ...baseMembership(),
      trendingItem: { count: trendingItemCount },
      autopilotPost: { count: autopilotPostCount },
      pipelineRun: { findFirst: pipelineRunFindFirst },
    } as any;
    const caller = createCallerFactory(autopilotRouter)({
      prisma,
      session: session(),
      organizationId: ORG_ID,
    });
    return { caller, autopilotPostCount };
  }

  it("returns failedCount alongside the existing counts", async () => {
    const { caller, autopilotPostCount } = buildCaller({
      trending: 5,
      reviewing: 2,
      today: 7,
      failed: 3,
    });

    const res = await caller.overview();

    expect(res).toMatchObject({
      trendingCount: 5,
      pendingReview: 2,
      postsToday: 7,
      failedCount: 3,
    });

    // One of the count() calls must be scoped to status: "FAILED" for this org.
    const failedCall = autopilotPostCount.mock.calls.find(
      (c: any[]) => c[0]?.where?.status === "FAILED"
    );
    expect(failedCall).toBeTruthy();
    expect(failedCall![0].where).toMatchObject({ organizationId: ORG_ID, status: "FAILED" });
  });
});
