/**
 * The two ways out of a HELD caption fan-out (owner decision 2026-09-28).
 *
 * When no unique caption can be generated for any channel, the worker parks the
 * post as a DRAFT with `metadata.captionFanout.held = true` — a publish gate —
 * instead of publishing the shared caption everywhere. A held post must never
 * be a dead end, so the post page offers:
 *
 *   post.retryUniqueCaptions — run the fan-out again (e.g. after topping up AI
 *     credit). Needs a FRESH jobId: finished jobs are retained in Redis, and
 *     re-adding the original `caption-fanout-{id}` id is silently ignored.
 *   post.releaseWithSharedCaption — release the hold and schedule the post with the
 *     shared caption, through the SAME gate the worker uses.
 *
 * Both are compare-and-set on the held flag, so a double click can never queue
 * two AI runs or flip twice.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../middleware/plan-limit.middleware", () => ({
  enforcePlanLimit: vi.fn(async () => undefined),
  requirePlan: vi.fn(async () => undefined),
  isBillingDisabled: () => false,
}));

const fanoutAdd = vi.fn(async (..._a: any[]) => ({}));
vi.mock("@postautomation/queue", () => ({
  pushProgress: vi.fn(async () => {}),
  finishProgress: vi.fn(async () => {}),
  scopedProgressId: (_u: string, p: string) => `scoped:${p}`,
  agentRunQueue: { add: vi.fn(async () => {}) },
  postPublishQueue: { add: vi.fn(async () => {}) },
  captionFanoutQueue: { add: (...a: any[]) => fanoutAdd(...a) },
  superTextQueue: { add: vi.fn(async () => {}) },
  enqueueScheduledPublishJobs: vi.fn(async () => 0),
  repurposeVideoQueue: { add: vi.fn(async () => {}) },
  buildPublishNowJobId: (t: string, n: number) => `pubnow:${t}:${Math.floor(n / 60_000)}`,
  PUBLISH_NOW_DEDUPE_WINDOW_MS: 60_000,
}));

/** Stateful post row so the REAL publish gate (not mocked) re-reads what we wrote. */
let row: { id: string; organizationId: string; status: string; scheduledAt: Date | null; metadata: any } | null;
const postUpdateMany = vi.fn();
const postUpdate = vi.fn();
const targetUpdateMany = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: {
    organizationMember: {
      findUnique: vi.fn(async () => ({ id: "m1", userId: "user-1", organizationId: "org-1", role: "MEMBER" })),
      findFirst: vi.fn(async () => ({ organizationId: "org-1" })),
    },
    organization: { findUnique: vi.fn(async () => ({ plan: "FREE", planExpiresAt: null })) },
    post: {
      findFirst: vi.fn(async (args: any) =>
        row && args?.where?.id === row.id && args?.where?.organizationId === row.organizationId ? { ...row } : null
      ),
      updateMany: (...a: any[]) => postUpdateMany(...a),
      update: (...a: any[]) => postUpdate(...a),
    },
    postTarget: { updateMany: (...a: any[]) => targetUpdateMany(...a) },
    auditLog: { create: vi.fn() },
  },
  ensurePersonalOrg: vi.fn(),
}));

import { createCallerFactory } from "../trpc";
import { postRouter } from "../routers/post.router";
import { prisma as prismaMock } from "@postautomation/db";
import { captionFanoutRetryJobId } from "../lib/caption-fanout";

const caller = () =>
  createCallerFactory(postRouter)({
    prisma: prismaMock as any,
    organizationId: "org-1",
    session: { user: { id: "user-1", email: "a@b.c", isSuperAdmin: false }, expires: "2099-01-01" } as any,
  });

const heldMeta = (extra: Record<string, unknown> = {}) => ({
  captionFanout: {
    requested: true,
    pendingSchedule: false,
    held: true,
    heldAt: "2026-09-28T15:30:00.000Z",
    reason: "every AI provider is out of credit",
    ...extra,
  },
  videoThumbnail: { mediaId: "m-thumb" },
});

beforeEach(() => {
  vi.clearAllMocks();
  row = { id: "post-1", organizationId: "org-1", status: "DRAFT", scheduledAt: new Date("2026-09-28T14:55:00Z"), metadata: heldMeta() };
  // Compare-and-set: succeeds only while the row is still held, and applies the write.
  postUpdateMany.mockImplementation(async (args: any) => {
    if (!row || row.status !== "DRAFT" || row.metadata?.captionFanout?.held !== true) return { count: 0 };
    row.metadata = args.data.metadata;
    return { count: 1 };
  });
  postUpdate.mockImplementation(async (args: any) => {
    Object.assign(row!, args.data);
    return row;
  });
  targetUpdateMany.mockResolvedValue({ count: 240 });
});

describe("captionFanoutRetryJobId", () => {
  it("is fresh per attempt and colon-free (BullMQ rejects most colon ids)", () => {
    expect(captionFanoutRetryJobId("post-1", 1)).toBe("caption-fanout-post-1-retry1");
    expect(captionFanoutRetryJobId("post-1", 2)).not.toBe(captionFanoutRetryJobId("post-1", 1));
    expect(captionFanoutRetryJobId("post-1", 1)).not.toContain(":");
  });
});

describe("post.retryUniqueCaptions", () => {
  it("re-arms the fan-out and queues a FRESH job", async () => {
    await expect(caller().retryUniqueCaptions({ id: "post-1" })).resolves.toEqual({ retrying: true, attempt: 1 });

    const where = postUpdateMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ id: "post-1", organizationId: "org-1", status: "DRAFT" });
    expect(where.metadata).toEqual({ path: ["captionFanout", "held"], equals: true });

    expect(row!.metadata.captionFanout).toEqual({ requested: true, pendingSchedule: true, retries: 1 });
    expect(row!.metadata.videoThumbnail).toEqual({ mediaId: "m-thumb" }); // sibling keys preserved
    expect(row!.status).toBe("DRAFT"); // the worker flips it, not us

    expect(fanoutAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = fanoutAdd.mock.calls[0]!;
    expect(data).toEqual({ postId: "post-1", organizationId: "org-1" });
    expect(opts).toEqual({ jobId: "caption-fanout-post-1-retry1" });
    expect(name).toBe("caption-fanout-post-1-retry1");
  });

  it("numbers attempts, so a second hold gets a second fresh job", async () => {
    row!.metadata = heldMeta({ retries: 1 });
    await expect(caller().retryUniqueCaptions({ id: "post-1" })).resolves.toEqual({ retrying: true, attempt: 2 });
    expect(fanoutAdd.mock.calls[0]![2]).toEqual({ jobId: "caption-fanout-post-1-retry2" });
  });

  it("a double click queues ONE run (compare-and-set on the held flag)", async () => {
    await caller().retryUniqueCaptions({ id: "post-1" });
    await expect(caller().retryUniqueCaptions({ id: "post-1" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fanoutAdd).toHaveBeenCalledTimes(1);
  });

  it("loses the race cleanly when another request released the hold in between", async () => {
    postUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(caller().retryUniqueCaptions({ id: "post-1" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fanoutAdd).not.toHaveBeenCalled();
  });

  it("puts the hold BACK if the job cannot be queued — never pending with nothing to finish it", async () => {
    fanoutAdd.mockRejectedValueOnce(new Error("redis down"));
    await expect(caller().retryUniqueCaptions({ id: "post-1" })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(row!.metadata.captionFanout.held).toBe(true);
    expect(row!.metadata.captionFanout.pendingSchedule).toBe(false);
  });

  it("refuses a post that is not held", async () => {
    row!.metadata = { captionFanout: { requested: true, pendingSchedule: true } };
    await expect(caller().retryUniqueCaptions({ id: "post-1" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    row!.metadata = heldMeta();
    row!.status = "PUBLISHED";
    await expect(caller().retryUniqueCaptions({ id: "post-1" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fanoutAdd).not.toHaveBeenCalled();
  });

  it("is org-scoped: another workspace's post is NOT_FOUND", async () => {
    row!.organizationId = "org-OTHER";
    await expect(caller().retryUniqueCaptions({ id: "post-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(postUpdateMany).not.toHaveBeenCalled();
  });
});

describe("post.releaseWithSharedCaption", () => {
  it("releases the hold and schedules the post through the real publish gate", async () => {
    await expect(caller().releaseWithSharedCaption({ id: "post-1" })).resolves.toEqual({
      scheduled: true,
      waitingForVideo: false,
    });

    const fanout = row!.metadata.captionFanout;
    expect(fanout).toMatchObject({ held: false, pendingSchedule: false, degraded: true, reason: "shared caption chosen" });
    // Targets BEFORE the post (a SCHEDULED post with DRAFT targets enqueues nothing).
    expect(targetUpdateMany).toHaveBeenCalledWith({
      where: { postId: "post-1", status: "DRAFT" },
      data: { status: "SCHEDULED" },
    });
    expect(targetUpdateMany.mock.invocationCallOrder[0]!).toBeLessThan(postUpdate.mock.invocationCallOrder.at(-1)!);
    expect(row!.status).toBe("SCHEDULED");
  });

  it("does not publish an un-burned video: waits for super text when a burn is pending", async () => {
    row!.metadata = { ...heldMeta(), superText: { pendingBurn: true } };
    await expect(caller().releaseWithSharedCaption({ id: "post-1" })).resolves.toEqual({
      scheduled: false,
      waitingForVideo: true,
    });
    expect(row!.status).toBe("DRAFT");
    expect(targetUpdateMany).not.toHaveBeenCalled();
  });

  it("a double click flips once", async () => {
    await caller().releaseWithSharedCaption({ id: "post-1" });
    await expect(caller().releaseWithSharedCaption({ id: "post-1" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(targetUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("refuses a post that is not held, and is org-scoped", async () => {
    row!.metadata = { captionFanout: { requested: true, pendingSchedule: true } };
    await expect(caller().releaseWithSharedCaption({ id: "post-1" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    row!.metadata = heldMeta();
    row!.organizationId = "org-OTHER";
    await expect(caller().releaseWithSharedCaption({ id: "post-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(targetUpdateMany).not.toHaveBeenCalled();
  });
});
