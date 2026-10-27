import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * One failed token refresh used to stop background refresh for that channel
 * FOREVER (TikTok audit, 2026-10-28).
 *
 * The cron adds `refresh-${channel.id}` with a fixed jobId so two overlapping
 * cron runs cannot queue the same refresh twice. But the queue default keeps a
 * FAILED job (`removeOnFail: { count: 1000 }`), and BullMQ silently ignores an
 * `add` whose jobId still exists — so after one refresh exhausted its attempts
 * (e.g. ~90s of TikTok 5xx), every later 30-minute cron run was a no-op for
 * that channel. TikTok access tokens live 24 hours.
 *
 * The fix keeps the jobId (dedupe still works while a refresh is waiting or
 * retrying) and removes the job once it has finally failed.
 */

const addMock = vi.fn();
const findManyMock = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: { channel: { findMany: (...a: any[]) => findManyMock(...a) } },
}));

vi.mock("@postautomation/queue", () => ({
  tokenRefreshQueue: { add: (...a: any[]) => addMock(...a) },
  analyticsSyncQueue: {}, agentRunQueue: {}, trendDiscoverQueue: {}, listeningSyncQueue: {},
  campaignAnalyticsSyncQueue: {}, brandContentSyncQueue: {}, outreachPollQueue: {},
  postPublishQueue: {}, rssSyncQueue: {}, avatarCacheQueue: {}, externalPostSyncQueue: {},
}));
vi.mock("../../workers/auto-healer.worker", () => ({ runAutoHealerWithLogging: vi.fn() }));
vi.mock("../../workers/celebrity-detect.worker", () => ({ runCelebrityDetectors: vi.fn() }));

import { scheduleTokenRefreshes } from "../cron-jobs";

beforeEach(() => {
  addMock.mockReset();
  findManyMock.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("scheduleTokenRefreshes", () => {
  it("still dedupes by a fixed per-channel jobId, and REMOVES a finally-failed job so the next run can retry", async () => {
    findManyMock.mockResolvedValue([
      { id: "tt1", platform: "TIKTOK" },
      { id: "yt1", platform: "YOUTUBE" },
    ]);

    await scheduleTokenRefreshes();

    expect(addMock).toHaveBeenCalledTimes(2);
    expect(addMock).toHaveBeenNthCalledWith(
      1,
      "refresh-tt1",
      { channelId: "tt1", platform: "TIKTOK" },
      { jobId: "refresh-tt1", removeOnComplete: true, removeOnFail: true }
    );
    expect(addMock.mock.calls[1]![2]).toEqual({ jobId: "refresh-yt1", removeOnComplete: true, removeOnFail: true });
  });

  it("only selects active channels with a refresh token expiring within the hour", async () => {
    findManyMock.mockResolvedValue([]);
    await scheduleTokenRefreshes();
    const where = findManyMock.mock.calls[0]![0].where;
    expect(where.isActive).toBe(true);
    expect(where.refreshToken).toEqual({ not: null });
    expect(where.tokenExpiresAt.lte).toBeInstanceOf(Date);
    expect(addMock).not.toHaveBeenCalled();
  });
});
