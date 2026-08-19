import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The "N channels need reconnecting to report Insights" banner must only nag about
 * channels where reconnecting actually restores something.
 *
 * ⚠️ THE REGRESSION THIS PREVENTS, measured on prod 2026-08-19:
 * **673 active channels carry `needs_reconnect`, and 665 of them (98.8%) have never
 * had an app-published PostTarget.** Those verdicts were written by
 * `external-post-sync.worker`'s `writeHealth`. With that sweep dormant (Insights
 * covers app-published posts only), such a channel is visited by NEITHER health
 * writer — analytics-sync iterates app-published targets, of which it has none — and
 * `shouldApplyHealthVerdict` clears a `needs_reconnect` only on a later CLEAN
 * capture. So the verdict is frozen on screen forever, telling the user to reconnect
 * hundreds of channels to restore metrics the pipeline no longer gathers.
 *
 * That is the perpetual-banner class PR #170 fixed, re-entered through a new
 * mechanism. The fix scopes the banner to the population Insights measures, which is
 * also exactly the set analytics-sync revisits — so verdicts stay fresh AND can
 * self-clear. Self-maintaining rather than a one-off data patch.
 */

vi.mock("@postautomation/queue", async () => {
  // Load the REAL population switch (pure, no Redis) so the gate under test is the
  // production one. Re-implementing `=== "true"` here would test the mock.
  const { insightsIncludeExternalPosts } = await import("../../../queue/src/insights-population");
  return {
    insightsIncludeExternalPosts,
    externalPostFloor: () => new Date("2026-08-01T00:00:00.000Z"),
    externalPostFloorLabel: () => "1 Aug 2026",
    analyticsSyncQueue: { add: vi.fn() },
    externalPostSyncQueue: { add: vi.fn() },
  };
});

import { createCallerFactory } from "../trpc";
import { analyticsRouter } from "../routers/analytics.router";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const KEY = "INSIGHTS_INCLUDE_EXTERNAL_POSTS";

/** Captures the `where` handed to channel.findMany. */
function harness() {
  // Typed with an explicit arg so `mock.calls[0][0]` — the whole point of this
  // harness — typechecks; a bare `vi.fn(async () => [])` has a zero-arity signature.
  const findMany = vi.fn(async (_args: { where: any; select?: any }) => [] as any[]);
  const prisma: any = {
    organizationMember: {
      findUnique: vi.fn(async () => ({
        userId: USER_ID,
        organizationId: ORG_ID,
        role: "OWNER",
      })),
    },
    organization: { findUnique: vi.fn(async () => ({ id: ORG_ID, plan: "FREE" })) },
    channel: { findMany },
  };
  const caller = createCallerFactory(analyticsRouter)({
    prisma,
    session: { user: { id: USER_ID, email: "u@example.com", isSuperAdmin: true } },
    organizationId: ORG_ID,
  } as any);
  return { caller, findMany };
}

beforeEach(() => {
  delete process.env[KEY];
});
afterEach(() => {
  delete process.env[KEY];
});

describe("analytics.insightsHealth scopes to the measured population", () => {
  it("only considers channels with app-published history by default", async () => {
    const { caller, findMany } = harness();
    await caller.insightsHealth();

    expect(findMany).toHaveBeenCalledTimes(1);
    const where = findMany.mock.calls[0]![0].where;
    // The predicate is what makes the banner honest: reconnecting one of these
    // channels genuinely restores metrics, because it has posts to measure.
    expect(where.postTargets).toEqual({ some: { status: "PUBLISHED" } });
    // Org scoping and the active filter must survive untouched (IDOR history).
    expect(where.organizationId).toBe(ORG_ID);
    expect(where.isActive).toBe(true);
  });

  it("drops the scope when direct posts are included, restoring old behavior", async () => {
    // With the wider population, a channel with no app-published posts CAN still
    // report Insights, so reconnecting it does help and the nag is legitimate.
    process.env[KEY] = "true";
    const { caller, findMany } = harness();
    await caller.insightsHealth();

    const where = findMany.mock.calls[0]![0].where;
    expect(where.postTargets).toBeUndefined();
    expect(where.organizationId).toBe(ORG_ID);
    expect(where.isActive).toBe(true);
  });

  it("treats an EMPTY flag value as the scoped default", async () => {
    process.env[KEY] = "";
    const { caller, findMany } = harness();
    await caller.insightsHealth();
    expect(findMany.mock.calls[0]![0].where.postTargets).toEqual({
      some: { status: "PUBLISHED" },
    });
  });

  it("still reports totalActiveChannels over the scoped set it evaluated", async () => {
    // The count drives the banner copy; it must describe the same set the verdicts
    // came from, or "3 of 121 channels" would mix two populations.
    const { caller } = harness();
    const res = await caller.insightsHealth();
    expect(res.totalActiveChannels).toBe(0);
    expect(res.needsReconnectCount).toBe(0);
  });
});
