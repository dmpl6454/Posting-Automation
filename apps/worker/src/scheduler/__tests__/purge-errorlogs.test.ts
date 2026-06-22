/**
 * Auto-purge keeps the Monitoring table from growing forever (2026-06-22).
 *
 * Policy:
 *   - RESOLVED errors older than 30 days (by resolvedAt, fallback lastSeenAt) → delete
 *   - UNRESOLVED errors older than 90 days (by lastSeenAt, never actioned)   → delete
 *
 * The pure where-builder is tested directly so the date math is verifiable
 * without a DB; the cron function is tested against a mocked deleteMany.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const deleteManyMock = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: { errorLog: { deleteMany: (...a: any[]) => deleteManyMock(...a) } },
}));
vi.mock("@postautomation/queue", () => ({
  rssSyncQueue: {}, tokenRefreshQueue: {}, analyticsSyncQueue: {}, agentRunQueue: {},
  trendDiscoverQueue: {}, listeningSyncQueue: {}, campaignAnalyticsSyncQueue: {},
  brandContentSyncQueue: {}, outreachPollQueue: {}, postPublishQueue: {},
}));
vi.mock("../../workers/auto-healer.worker", () => ({ runAutoHealerWithLogging: vi.fn() }));
vi.mock("../../workers/celebrity-detect.worker", () => ({ runCelebrityDetectors: vi.fn() }));

import { buildErrorLogPurgeWhere, purgeOldErrorLogs } from "../cron-jobs";

describe("buildErrorLogPurgeWhere", () => {
  const now = new Date("2026-06-22T12:00:00.000Z");

  it("targets resolved rows older than the resolved window OR unresolved older than the stale window", () => {
    const where = buildErrorLogPurgeWhere(now, 30, 90);
    const thirtyDaysAgo = new Date("2026-05-23T12:00:00.000Z");
    const ninetyDaysAgo = new Date("2026-03-24T12:00:00.000Z");

    expect(where).toEqual({
      OR: [
        {
          resolved: true,
          OR: [
            { resolvedAt: { lt: thirtyDaysAgo } },
            { resolvedAt: null, lastSeenAt: { lt: thirtyDaysAgo } },
          ],
        },
        { resolved: false, lastSeenAt: { lt: ninetyDaysAgo } },
      ],
    });
  });
});

describe("purgeOldErrorLogs", () => {
  beforeEach(() => deleteManyMock.mockReset());

  it("calls deleteMany with the purge where-clause and returns the count", async () => {
    deleteManyMock.mockResolvedValue({ count: 7 });
    const count = await purgeOldErrorLogs();
    expect(deleteManyMock).toHaveBeenCalledTimes(1);
    const arg = deleteManyMock.mock.calls[0]![0];
    expect(arg).toHaveProperty("where.OR");
    expect(count).toBe(7);
  });
});
