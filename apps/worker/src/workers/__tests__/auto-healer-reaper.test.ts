/**
 * The auto-healer's stuck-PUBLISHING reaper (step 5), hardened 2026-09-16:
 *   - it ran ONLY when there were failed autopilot posts (an early return
 *     skipped it otherwise — i.e. nearly always);
 *   - it took an unordered 20, so a 60-target orphan needed several cycles;
 *   - its unconditional write could clobber a target that had just finished;
 *   - it left retryCount at 0, so a later human Retry skipped the duplicate
 *     pre-flight (post.publishNow clears errorMessage, the other signal).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    $queryRaw: vi.fn(async () => [{ "?column?": 1 }]),
    autopilotPost: {
      findMany: vi.fn(async (_args?: any): Promise<any[]> => []),
      update: vi.fn(async () => ({})),
    },
    postTarget: {
      findMany: vi.fn(async (_args?: any): Promise<any[]> => []),
      updateMany: vi.fn(async (_args?: any): Promise<{ count: number }> => ({ count: 1 })),
      update: vi.fn(async () => ({})),
    },
  },
  queue: {
    contentGenerateQueue: { add: vi.fn(async () => ({})) },
    autopilotScheduleQueue: { add: vi.fn(async () => ({})) },
  },
  redisDown: false,
}));

vi.mock("@postautomation/db", () => ({ prisma: h.prisma }));
vi.mock("@postautomation/queue", () => ({
  contentGenerateQueue: h.queue.contentGenerateQueue,
  autopilotScheduleQueue: h.queue.autopilotScheduleQueue,
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    send = async () => ({});
    destroy() {}
  },
  HeadBucketCommand: class {},
}));
vi.mock("ioredis", () => ({
  default: class {
    async connect() {
      if (h.redisDown) throw new Error("ECONNREFUSED");
    }
    async ping() {
      return "PONG";
    }
    async quit() {
      return "OK";
    }
  },
}));

import { runAutoHealer, reapStuckPublishingTargets, STUCK_PUBLISHING_MESSAGE } from "../auto-healer.worker";

const NOW = new Date("2026-09-16T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60 * 1000);

beforeEach(() => {
  vi.clearAllMocks();
  h.redisDown = false;
  h.prisma.autopilotPost.findMany.mockResolvedValue([]);
  h.prisma.postTarget.findMany.mockResolvedValue([]);
  h.prisma.postTarget.updateMany.mockResolvedValue({ count: 1 });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("reapStuckPublishingTargets", () => {
  it("queries oldest-first, 100 per cycle, only PUBLISHING targets idle for 30+ min", async () => {
    await reapStuckPublishingTargets(NOW);

    expect(h.prisma.postTarget.findMany).toHaveBeenCalledTimes(1);
    const arg = h.prisma.postTarget.findMany.mock.calls[0]![0] as any;
    expect(arg.where).toEqual({ status: "PUBLISHING", updatedAt: { lt: minutesAgo(30) } });
    expect(arg.orderBy).toEqual({ updatedAt: "asc" });
    expect(arg.take).toBe(100);
  });

  it("writes CONDITIONALLY and increments retryCount", async () => {
    h.prisma.postTarget.findMany.mockResolvedValue([
      { id: "t1", status: "PUBLISHING", updatedAt: minutesAgo(45) },
      { id: "t2", status: "PUBLISHING", updatedAt: minutesAgo(31) },
    ]);

    const reaped = await reapStuckPublishingTargets(NOW);

    expect(reaped).toBe(2);
    expect(h.prisma.postTarget.update).not.toHaveBeenCalled();
    expect(h.prisma.postTarget.updateMany).toHaveBeenCalledTimes(2);
    expect(h.prisma.postTarget.updateMany.mock.calls[0]![0]).toEqual({
      where: { id: "t1", status: "PUBLISHING", updatedAt: { lt: minutesAgo(30) } },
      data: {
        status: "FAILED",
        errorMessage: STUCK_PUBLISHING_MESSAGE,
        retryCount: { increment: 1 },
      },
    });
  });

  it("keeps the user-facing message unchanged", () => {
    expect(STUCK_PUBLISHING_MESSAGE).toBe("Publishing stuck for over 30 minutes — please retry");
  });

  it("does not count a target that finished between the read and the write", async () => {
    h.prisma.postTarget.findMany.mockResolvedValue([
      { id: "t1", status: "PUBLISHING", updatedAt: minutesAgo(45) },
      { id: "t2", status: "PUBLISHING", updatedAt: minutesAgo(45) },
    ]);
    h.prisma.postTarget.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    expect(await reapStuckPublishingTargets(NOW)).toBe(1);
  });

  it("still honours shouldReapPublishing and survives a failed write", async () => {
    h.prisma.postTarget.findMany.mockResolvedValue([
      { id: "fresh", status: "PUBLISHING", updatedAt: minutesAgo(5) }, // not stale → skipped
      { id: "t1", status: "PUBLISHING", updatedAt: minutesAgo(45) },
      { id: "t2", status: "PUBLISHING", updatedAt: minutesAgo(45) },
    ]);
    h.prisma.postTarget.updateMany.mockRejectedValueOnce(new Error("db blip")).mockResolvedValueOnce({ count: 1 });

    expect(await reapStuckPublishingTargets(NOW)).toBe(1);
    expect(h.prisma.postTarget.updateMany.mock.calls.map((c: any[]) => c[0].where.id)).toEqual(["t1", "t2"]);
  });
});

describe("runAutoHealer step 5 scheduling", () => {
  it("reaps even when there are NO failed autopilot posts (the old early return skipped it)", async () => {
    h.prisma.postTarget.findMany.mockResolvedValue([{ id: "t1", status: "PUBLISHING", updatedAt: new Date(0) }]);

    const result = await runAutoHealer();

    expect(result.scanned).toBe(0);
    expect(h.prisma.postTarget.updateMany).toHaveBeenCalledTimes(1);
    // Steps 3-4 are still skipped in that case, exactly as before.
    expect(h.prisma.autopilotPost.findMany).toHaveBeenCalledTimes(1);
    expect((h.prisma.autopilotPost.findMany.mock.calls[0]![0] as any).where.status).toBe("FAILED");
    expect(h.queue.contentGenerateQueue.add).not.toHaveBeenCalled();
  });

  it("reaps once per cycle when there ARE failed autopilot posts", async () => {
    h.prisma.autopilotPost.findMany
      .mockResolvedValueOnce([
        { id: "ap1", organizationId: "o1", errorMessage: "ECONNRESET", createdAt: new Date(), retryCount: 0 },
      ])
      .mockResolvedValueOnce([]); // step 4: no stuck SCHEDULED autopilot posts
    h.prisma.postTarget.findMany.mockResolvedValue([{ id: "t1", status: "PUBLISHING", updatedAt: new Date(0) }]);

    const result = await runAutoHealer();

    expect(result.retried).toBe(1);
    expect(h.prisma.postTarget.findMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.postTarget.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not reap while Redis/Postgres are down (step 1 behaviour unchanged)", async () => {
    h.redisDown = true;

    await runAutoHealer();

    expect(h.prisma.autopilotPost.findMany).not.toHaveBeenCalled();
    expect(h.prisma.postTarget.findMany).not.toHaveBeenCalled();
  });
});
