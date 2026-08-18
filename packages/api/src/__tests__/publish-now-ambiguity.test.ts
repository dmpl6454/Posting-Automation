/**
 * `post.publishNow` is the Retry button. Two defects it carried into the
 * 2026-08-13 duplicate-post incident, both locked here:
 *
 *  1. It passed NO jobId, so BullMQ minted a fresh auto-increment id per call and
 *     repeated clicks could never dedupe. Verified in prod Redis: one target was
 *     enqueued as jobs 1576349 and 1576351 from two clicks 81s apart, each with
 *     `attempts: 3`.
 *  2. It re-armed every FAILED target indiscriminately. A target whose publish
 *     outcome is UNKNOWN (PostTarget.ambiguousAt) must be excluded, or the button
 *     re-posts something that may already be live.
 *
 * Plus the new escape hatch: `clearPublishAmbiguity`, the operator's "I checked,
 * it didn't publish" override that re-arms the ordinary retry path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../middleware/plan-limit.middleware", () => ({
  enforcePlanLimit: vi.fn(async () => undefined),
  requirePlan: vi.fn(async () => undefined),
  isBillingDisabled: () => false,
}));

const queueAdd = vi.fn(async () => ({}));
vi.mock("@postautomation/queue", () => ({
  pushProgress: vi.fn(async () => {}),
  finishProgress: vi.fn(async () => {}),
  scopedProgressId: (_u: string, p: string) => `scoped:${p}`,
  agentRunQueue: { add: vi.fn(async () => {}) },
  postPublishQueue: { add: (...a: any[]) => queueAdd(...(a as [])) },
  enqueueScheduledPublishJobs: vi.fn(async () => 0),
  repurposeVideoQueue: { add: vi.fn(async () => {}) },
  buildPublishNowJobId: (targetId: string, nowMs: number) =>
    `pubnow:${targetId}:${Math.floor(nowMs / 60_000)}`,
  PUBLISH_NOW_DEDUPE_WINDOW_MS: 60_000,
}));

const orgMemberFindUnique = vi.fn();
const orgMemberFindFirst = vi.fn();
const orgFindUnique = vi.fn();
const postFindFirst = vi.fn();
const postUpdate = vi.fn();
const targetUpdateMany = vi.fn();
const targetFindMany = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: (...a: any[]) => orgMemberFindUnique(...a),
      findFirst: (...a: any[]) => orgMemberFindFirst(...a),
    },
    organization: { findUnique: (...a: any[]) => orgFindUnique(...a) },
    post: { findFirst: (...a: any[]) => postFindFirst(...a), update: (...a: any[]) => postUpdate(...a) },
    postTarget: {
      updateMany: (...a: any[]) => targetUpdateMany(...a),
      findMany: (...a: any[]) => targetFindMany(...a),
    },
    auditLog: { create: vi.fn() },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { postRouter } from "../routers/post.router";
import { prisma as prismaMock } from "@postautomation/db";

const ORG_ID = "org-1";

function makeCaller() {
  return createCallerFactory(postRouter)({
    prisma: prismaMock as any,
    organizationId: ORG_ID,
    session: { user: { id: "user-1", email: "a@b.c", isSuperAdmin: false }, expires: "2099-01-01" } as any,
  });
}

const target = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  channelId: "c1",
  status: "FAILED",
  ambiguousAt: null,
  channel: { platform: "INSTAGRAM" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  orgMemberFindUnique.mockResolvedValue({ id: "m1", userId: "user-1", organizationId: ORG_ID, role: "OWNER" });
  orgMemberFindFirst.mockResolvedValue({ organizationId: ORG_ID });
  orgFindUnique.mockResolvedValue({ plan: "FREE", planExpiresAt: null });
  postUpdate.mockResolvedValue({ id: "p1" });
  targetUpdateMany.mockResolvedValue({ count: 1 });
});

describe("post.publishNow — job identity", () => {
  it("supplies a deterministic jobId so repeated clicks collapse", async () => {
    postFindFirst.mockResolvedValue({ id: "p1", metadata: null, targets: [target()] });
    await makeCaller().publishNow({ id: "p1" });

    expect(queueAdd).toHaveBeenCalledTimes(1);
    const opts = (queueAdd.mock.calls[0] as any[])[2];
    expect(opts.jobId).toMatch(/^pubnow:t1:\d+$/);
    expect(opts.jobId.split(":")).toHaveLength(3);
  });

  it("keeps the interactive fast lane — no priority is set", async () => {
    // BullMQ drains the unprioritized wait list before ANY prioritized job, so
    // "no priority" IS the fast lane. Adding one here would demote user clicks.
    postFindFirst.mockResolvedValue({ id: "p1", metadata: null, targets: [target()] });
    await makeCaller().publishNow({ id: "p1" });
    const opts = (queueAdd.mock.calls[0] as any[])[2];
    expect(opts.priority).toBeUndefined();
  });
});

describe("post.publishNow — ambiguous targets are not re-published", () => {
  it("excludes an ambiguous target from the implicit all-eligible set", async () => {
    postFindFirst.mockResolvedValue({
      id: "p1",
      metadata: null,
      targets: [target({ id: "ok" }), target({ id: "unknown", ambiguousAt: new Date() })],
    });
    await makeCaller().publishNow({ id: "p1" });

    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect((queueAdd.mock.calls[0] as any[])[1].postTargetId).toBe("ok");
  });

  it("refuses an ambiguous target even when named EXPLICITLY", async () => {
    // The whole point: an explicit id must not be a bypass, because the post may
    // already be live and this call would create a second copy.
    postFindFirst.mockResolvedValue({
      id: "p1",
      metadata: null,
      targets: [target({ id: "unknown", ambiguousAt: new Date() })],
    });
    await expect(makeCaller().publishNow({ id: "p1", targetIds: ["unknown"] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("still refuses to publish while a super-text burn is pending", async () => {
    postFindFirst.mockResolvedValue({
      id: "p1",
      metadata: { superText: { pendingBurn: true } },
      targets: [target()],
    });
    await expect(makeCaller().publishNow({ id: "p1" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("still excludes PUBLISHED targets when ids are given explicitly", async () => {
    postFindFirst.mockResolvedValue({
      id: "p1",
      metadata: null,
      targets: [target({ id: "done", status: "PUBLISHED" })],
    });
    await expect(makeCaller().publishNow({ id: "p1", targetIds: ["done"] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("post.clearPublishAmbiguity", () => {
  it("clears the stamp so the ordinary retry path is re-armed", async () => {
    postFindFirst.mockResolvedValue({ id: "p1", targets: [target({ ambiguousAt: new Date() })] });
    const res = await makeCaller().clearPublishAmbiguity({ id: "p1", targetIds: ["t1"] });

    expect(res).toEqual({ cleared: 1 });
    expect(targetUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["t1"] }, postId: "p1" },
      data: { ambiguousAt: null, ambiguousReason: null },
    });
  });

  it("is org-scoped — a cross-org post id is NOT_FOUND and writes nothing", async () => {
    postFindFirst.mockResolvedValue(null);
    await expect(
      makeCaller().clearPublishAmbiguity({ id: "other-org", targetIds: ["t1"] })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(targetUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses target ids that do not belong to the post (IDOR guard)", async () => {
    postFindFirst.mockResolvedValue({ id: "p1", targets: [target({ id: "t1" })] });
    await expect(
      makeCaller().clearPublishAmbiguity({ id: "p1", targetIds: ["foreign"] })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(targetUpdateMany).not.toHaveBeenCalled();
  });

  it("never clears a PUBLISHED target — its outcome is already known", async () => {
    postFindFirst.mockResolvedValue({
      id: "p1",
      targets: [target({ id: "t1", status: "PUBLISHED", ambiguousAt: new Date() })],
    });
    await expect(
      makeCaller().clearPublishAmbiguity({ id: "p1", targetIds: ["t1"] })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(targetUpdateMany).not.toHaveBeenCalled();
  });
});
