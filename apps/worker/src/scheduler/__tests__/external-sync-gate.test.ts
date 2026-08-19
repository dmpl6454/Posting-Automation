import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The worker must make NO Graph calls for posts it did not publish.
 *
 * Owner decision 2026-08-19: Insights covers posts published through
 * PostAutomation, end to end. Ingestion and display are governed by ONE switch so
 * the two containers cannot disagree — a worker still sweeping while the web app
 * has stopped reading would burn Meta quota on rows nobody can see.
 *
 * ⚠️ The gate is asserted to sit BEFORE the channel query, not merely before the
 * enqueue. `prisma.channel.findMany` over every active FB/IG row is ~1,339 rows on
 * prod; running it every 2 hours to then discard the result is pure waste.
 *
 * ⚠️ `insightsIncludeExternalPosts` is imported from its REAL module rather than
 * re-implemented in the mock factory. Inlining `process.env.X === "true"` here
 * would make the suite pass even if the production gate were inverted — testing
 * the mock instead of the code.
 */

const addMock = vi.fn();
const findManyMock = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: { channel: { findMany: (...a: any[]) => findManyMock(...a) } },
}));

vi.mock("@postautomation/queue", async () => {
  // Pure module, zero dependencies (no Redis) — safe to load for real.
  const { insightsIncludeExternalPosts } = await import(
    "../../../../../packages/queue/src/insights-population"
  );
  return {
    insightsIncludeExternalPosts,
    externalPostSyncQueue: { add: (...a: any[]) => addMock(...a) },
    externalPostFloor: () => new Date("2026-08-01T00:00:00.000Z"),
    tokenRefreshQueue: {}, analyticsSyncQueue: {}, agentRunQueue: {},
    trendDiscoverQueue: {}, listeningSyncQueue: {}, campaignAnalyticsSyncQueue: {},
    brandContentSyncQueue: {}, outreachPollQueue: {}, postPublishQueue: {},
    rssSyncQueue: {}, avatarCacheQueue: {},
  };
});
vi.mock("../../workers/auto-healer.worker", () => ({ runAutoHealerWithLogging: vi.fn() }));
vi.mock("../../workers/celebrity-detect.worker", () => ({ runCelebrityDetectors: vi.fn() }));

import { scheduleExternalPostSync } from "../cron-jobs";

const KEY = "INSIGHTS_INCLUDE_EXTERNAL_POSTS";

const CHANNEL = {
  id: "ch1",
  organizationId: "org1",
  platform: "FACEBOOK",
  platformId: "page1",
  metadata: null,
  updatedAt: new Date("2026-08-19T00:00:00.000Z"),
};

beforeEach(() => {
  addMock.mockReset();
  findManyMock.mockReset();
  findManyMock.mockResolvedValue([CHANNEL]);
  delete process.env[KEY];
  delete process.env.EXTERNAL_SYNC_ENABLED;
  // ⚠️ Pin to ONE shard. The sweep is sharded by a stable hash of the account, so
  // with the default 4 a single fixture account lands in the active shard only 1
  // run in 4 — which made "enqueues nothing" pass for the wrong reason (sharding,
  // not the gate) and made the re-enabled case fail spuriously. With 1 shard,
  // "nothing was enqueued" can only mean the gate stopped it.
  process.env.EXTERNAL_SYNC_SHARDS = "1";
});
afterEach(() => {
  delete process.env[KEY];
  delete process.env.EXTERNAL_SYNC_ENABLED;
  delete process.env.EXTERNAL_SYNC_SHARDS;
});

describe("scheduleExternalPostSync — app-published-only by default", () => {
  it("enqueues nothing when the flag is unset", async () => {
    await scheduleExternalPostSync();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("does not even QUERY for channels — the gate precedes the round-trip", async () => {
    await scheduleExternalPostSync();
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("treats an EMPTY value as disabled (compose allowlist trap)", async () => {
    process.env[KEY] = "";
    await scheduleExternalPostSync();
    expect(findManyMock).not.toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("does not accept truthy synonyms as an opt-in", async () => {
    for (const raw of ["TRUE", "1", "yes"]) {
      process.env[KEY] = raw;
      await scheduleExternalPostSync();
    }
    expect(addMock).not.toHaveBeenCalled();
  });
});

describe("scheduleExternalPostSync — still works when deliberately re-enabled", () => {
  it("sweeps as before on the exact string 'true'", async () => {
    process.env[KEY] = "true";
    await scheduleExternalPostSync();
    expect(findManyMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the 3-segment BullMQ jobId shape", async () => {
    process.env[KEY] = "true";
    await scheduleExternalPostSync();
    const jobId: string = addMock.mock.calls[0]![2].jobId;
    // BullMQ >=5.70 rejects a custom jobId that is not exactly 3 colon segments.
    expect(jobId.split(":")).toHaveLength(3);
    expect(jobId).toMatch(/^extsync:/);
  });

  it("keeps EXTERNAL_SYNC_ENABLED=false as an INDEPENDENT ingestion brake", async () => {
    // Two switches are not redundant here: this one kills ingestion only, while
    // the population switch governs reads AND ingestion together. Either must be
    // sufficient to stop the sweep.
    process.env[KEY] = "true";
    process.env.EXTERNAL_SYNC_ENABLED = "false";
    await scheduleExternalPostSync();
    expect(findManyMock).not.toHaveBeenCalled();
    expect(addMock).not.toHaveBeenCalled();
  });
});
