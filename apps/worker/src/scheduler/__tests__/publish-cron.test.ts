import { describe, it, expect, vi, beforeEach } from "vitest";

const addMock = vi.fn();
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
  postPublishQueue: { add: (...a: any[]) => addMock(...a) },
  rssSyncQueue: {}, tokenRefreshQueue: {}, analyticsSyncQueue: {}, agentRunQueue: {},
  trendDiscoverQueue: {}, listeningSyncQueue: {}, campaignAnalyticsSyncQueue: {},
  brandContentSyncQueue: {}, outreachPollQueue: {}, avatarCacheQueue: {},
}));
vi.mock("../../workers/auto-healer.worker", () => ({ runAutoHealerWithLogging: vi.fn() }));
vi.mock("../../workers/celebrity-detect.worker", () => ({ runCelebrityDetectors: vi.fn() }));

import { publishScheduledPosts } from "../cron-jobs";

function duePost(id: string, platforms: string[]) {
  return {
    id,
    organizationId: "org1",
    targets: platforms.map((platform, i) => ({
      id: `${id}-t${i}`,
      channelId: `${id}-c${i}`,
      channel: { platform },
    })),
  };
}

beforeEach(() => {
  addMock.mockReset();
  findManyMock.mockReset();
  updateMock.mockReset();
  updateMock.mockResolvedValue({});
});

describe("publishScheduledPosts", () => {
  it("enqueues one bulk-priority job per target with platform-grouped stagger, then flips the post to PUBLISHING", async () => {
    findManyMock.mockResolvedValueOnce([
      duePost("p1", ["FACEBOOK", "TELEGRAM", "FACEBOOK"]),
    ]);
    findManyMock.mockResolvedValue([]);

    await publishScheduledPosts();

    expect(addMock).toHaveBeenCalledTimes(3);
    const opts = addMock.mock.calls.map((c) => c[2]);
    // First target of EVERY platform starts immediately; only the second
    // FACEBOOK target waits its same-platform stagger.
    expect(opts.map((o) => o.delay)).toEqual([0, 0, 10_000]);
    // Bulk lane — must yield to unprioritized interactive publishNow jobs.
    for (const o of opts) expect(o.priority).toBe(5);
    expect(addMock.mock.calls[0]![1]).toMatchObject({
      postId: "p1",
      postTargetId: "p1-t0",
      channelId: "p1-c0",
      platform: "FACEBOOK",
      organizationId: "org1",
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
    expect(addMock).toHaveBeenCalledTimes(51);
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
