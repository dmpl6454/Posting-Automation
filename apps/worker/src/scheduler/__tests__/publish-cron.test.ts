import { describe, it, expect, vi, beforeEach } from "vitest";

const enqueueMock = vi.fn();
const findManyMock = vi.fn();
const updateMock = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: {
    post: {
      findMany: (...a: any[]) => findManyMock(...a),
      update: (...a: any[]) => updateMock(...a),
    },
  },
}));
vi.mock("@postautomation/queue", () => ({
  enqueueScheduledPublishJobs: (...a: any[]) => enqueueMock(...a),
  postPublishQueue: {}, rssSyncQueue: {}, tokenRefreshQueue: {}, analyticsSyncQueue: {},
  agentRunQueue: {}, trendDiscoverQueue: {}, listeningSyncQueue: {},
  campaignAnalyticsSyncQueue: {}, brandContentSyncQueue: {}, outreachPollQueue: {},
  avatarCacheQueue: {},
}));
vi.mock("../../workers/auto-healer.worker", () => ({ runAutoHealerWithLogging: vi.fn() }));
vi.mock("../../workers/celebrity-detect.worker", () => ({ runCelebrityDetectors: vi.fn() }));

import { publishScheduledPosts } from "../cron-jobs";

function duePost(id: string, platforms: string[], scheduledAt = new Date("2026-07-20T05:00:00Z")) {
  return {
    id,
    organizationId: "org1",
    scheduledAt,
    targets: platforms.map((platform, i) => ({
      id: `${id}-t${i}`,
      channelId: `${id}-c${i}`,
      channel: { platform },
    })),
  };
}

beforeEach(() => {
  enqueueMock.mockReset();
  enqueueMock.mockImplementation(async (args: any) => args.targets.length);
  findManyMock.mockReset();
  updateMock.mockReset();
  updateMock.mockResolvedValue({});
});

describe("publishScheduledPosts", () => {
  it("reconciliation-enqueues each due post via the shared helper (deterministic ids), then flips it to PUBLISHING", async () => {
    const scheduledAt = new Date("2026-07-20T04:59:40Z");
    findManyMock.mockResolvedValueOnce([duePost("p1", ["FACEBOOK", "TELEGRAM"], scheduledAt)]);
    findManyMock.mockResolvedValue([]);

    await publishScheduledPosts();

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    // Same args shape the create-path uses — that arg parity (postId +
    // scheduledAt + target ids) is what makes the jobIds collide and dedupe.
    expect(enqueueMock.mock.calls[0]![0]).toEqual({
      postId: "p1",
      organizationId: "org1",
      scheduledAt,
      targets: [
        { id: "p1-t0", channelId: "p1-c0", platform: "FACEBOOK" },
        { id: "p1-t1", channelId: "p1-c1", platform: "TELEGRAM" },
      ],
    });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { status: "PUBLISHING" },
    });
  });

  it("drains multiple batches when a full batch (50) comes back, instead of waiting a whole cycle", async () => {
    const fullBatch = Array.from({ length: 50 }, (_, i) => duePost(`a${i}`, ["TWITTER"]));
    findManyMock.mockResolvedValueOnce(fullBatch);
    findManyMock.mockResolvedValueOnce([duePost("b0", ["TWITTER"])]);

    await publishScheduledPosts();

    expect(findManyMock).toHaveBeenCalledTimes(2); // second batch < 50 → stop
    expect(enqueueMock).toHaveBeenCalledTimes(51);
  });

  it("stops after one query when the first batch is not full", async () => {
    findManyMock.mockResolvedValueOnce([duePost("p1", ["REDDIT"])]);
    await publishScheduledPosts();
    expect(findManyMock).toHaveBeenCalledTimes(1);
  });

  it("is re-entrancy guarded: an overlapping call is a no-op while a scan is in flight", async () => {
    let release!: (v: any[]) => void;
    findManyMock.mockImplementationOnce(
      () => new Promise<any[]>((resolve) => { release = resolve; })
    );

    const first = publishScheduledPosts(); // blocks on findMany
    await publishScheduledPosts(); // must return immediately without querying
    expect(findManyMock).toHaveBeenCalledTimes(1);

    release([]);
    await first;

    // Guard resets after the scan finishes
    findManyMock.mockResolvedValue([]);
    await publishScheduledPosts();
    expect(findManyMock).toHaveBeenCalledTimes(2);
  });
});
