import { describe, it, expect, vi, beforeEach } from "vitest";

const addMock = vi.fn();
const findManyMock = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: { rssFeed: { findMany: (...a: any[]) => findManyMock(...a) } },
}));
vi.mock("@postautomation/queue", () => ({
  rssSyncQueue: { add: (...a: any[]) => addMock(...a) },
  tokenRefreshQueue: {}, analyticsSyncQueue: {}, agentRunQueue: {},
  trendDiscoverQueue: {}, listeningSyncQueue: {}, campaignAnalyticsSyncQueue: {},
  brandContentSyncQueue: {}, outreachPollQueue: {}, postPublishQueue: {},
}));
vi.mock("../../workers/auto-healer.worker", () => ({ runAutoHealerWithLogging: vi.fn() }));
vi.mock("../../workers/celebrity-detect.worker", () => ({ runCelebrityDetectors: vi.fn() }));

import { scheduleRssSync } from "../cron-jobs";

beforeEach(() => { addMock.mockReset(); findManyMock.mockReset(); });

describe("scheduleRssSync", () => {
  it("enqueues feeds never checked", async () => {
    findManyMock.mockResolvedValue([
      { id: "f1", organizationId: "o1", checkInterval: 60, lastCheckedAt: null },
    ]);
    await scheduleRssSync();
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock.mock.calls[0][1]).toEqual({ feedId: "f1", organizationId: "o1" });
  });

  it("skips feeds checked within their interval", async () => {
    findManyMock.mockResolvedValue([
      { id: "f1", organizationId: "o1", checkInterval: 60, lastCheckedAt: new Date(Date.now() - 10 * 60 * 1000) },
    ]);
    await scheduleRssSync();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("enqueues feeds past their interval", async () => {
    findManyMock.mockResolvedValue([
      { id: "f1", organizationId: "o1", checkInterval: 60, lastCheckedAt: new Date(Date.now() - 90 * 60 * 1000) },
    ]);
    await scheduleRssSync();
    expect(addMock).toHaveBeenCalledTimes(1);
  });
});
