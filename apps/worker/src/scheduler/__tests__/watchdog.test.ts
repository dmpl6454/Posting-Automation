import { describe, it, expect, vi, beforeEach } from "vitest";

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
  enqueueScheduledPublishJobs: vi.fn(), postPublishQueue: {}, rssSyncQueue: {},
  tokenRefreshQueue: {}, analyticsSyncQueue: {}, agentRunQueue: {}, trendDiscoverQueue: {},
  listeningSyncQueue: {}, campaignAnalyticsSyncQueue: {}, brandContentSyncQueue: {},
  outreachPollQueue: {}, avatarCacheQueue: {},
}));
vi.mock("../../workers/auto-healer.worker", () => ({ runAutoHealerWithLogging: vi.fn() }));
vi.mock("../../workers/celebrity-detect.worker", () => ({ runCelebrityDetectors: vi.fn() }));

import { watchdogPublishingPosts } from "../cron-jobs";

const NOW = Date.now();
const recent = new Date(NOW - 2 * 60 * 1000);   // 2 min ago — "live"
const old = new Date(NOW - 40 * 60 * 1000);     // 40 min ago — idle
const postAge = new Date(NOW - 60 * 60 * 1000); // post PUBLISHING for 1h — normal candidate
const ancient = new Date(NOW - 13 * 60 * 60 * 1000); // 13h — past the 12h hard ceiling

beforeEach(() => {
  findManyMock.mockReset();
  updateMock.mockReset();
  updateMock.mockResolvedValue({});
});

describe("watchdogPublishingPosts", () => {
  it("does nothing when no posts are stuck", async () => {
    findManyMock.mockResolvedValue([]);
    await watchdogPublishingPosts();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("SKIPS a post whose non-terminal target updated recently (large upload in flight)", async () => {
    findManyMock.mockResolvedValue([
      { id: "p-live", updatedAt: postAge, targets: [{ status: "PUBLISHING", updatedAt: recent }] },
    ]);
    await watchdogPublishingPosts();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("FAILS a post whose non-terminal targets are all idle (genuinely stuck)", async () => {
    findManyMock.mockResolvedValue([
      { id: "p-stuck", updatedAt: postAge, targets: [{ status: "PUBLISHING", updatedAt: old }] },
    ]);
    await watchdogPublishingPosts();
    expect(updateMock).toHaveBeenCalledWith({ where: { id: "p-stuck" }, data: { status: "FAILED" } });
  });

  it("resolves an all-terminal post to PUBLISHED when any target published", async () => {
    findManyMock.mockResolvedValue([
      { id: "p-done", updatedAt: postAge, targets: [{ status: "PUBLISHED", updatedAt: old }, { status: "FAILED", updatedAt: old }] },
    ]);
    await watchdogPublishingPosts();
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p-done" }, data: expect.objectContaining({ status: "PUBLISHED" }) })
    );
  });

  it("resolves an all-FAILED post to FAILED", async () => {
    findManyMock.mockResolvedValue([
      { id: "p-fail", updatedAt: postAge, targets: [{ status: "FAILED", updatedAt: old }] },
    ]);
    await watchdogPublishingPosts();
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p-fail" }, data: expect.objectContaining({ status: "FAILED" }) })
    );
  });

  it("a live target protects a post even when a sibling target already failed", async () => {
    findManyMock.mockResolvedValue([
      { id: "p-mixed", updatedAt: postAge, targets: [
        { status: "FAILED", updatedAt: old },
        { status: "PUBLISHING", updatedAt: recent },
      ] },
    ]);
    await watchdogPublishingPosts();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("REAPS a post past the 12h hard ceiling even with a fresh target (perpetual retry loop)", async () => {
    findManyMock.mockResolvedValue([
      { id: "p-loop", updatedAt: ancient, targets: [{ status: "SCHEDULED", updatedAt: recent }] },
    ]);
    await watchdogPublishingPosts();
    expect(updateMock).toHaveBeenCalledWith({ where: { id: "p-loop" }, data: { status: "FAILED" } });
  });
});
