/**
 * Guard for campaign.setMonitoring + the list-derived monitoring state
 * (honesty relabel, 2026-06-29).
 *
 * Background: Campaigns used to show a fake ACTIVE/PAUSED status with play/pause
 * buttons that drove NOTHING. The honest replacement is a "Monitoring on/off"
 * toggle that flips isActive on the campaign's BrandTrackers — which is exactly
 * the field the brand-content-sync cron reads
 * (`brandTracker.findMany({ where: { isActive: true } })`). So toggling actually
 * starts/stops real background content fetching.
 *
 * These exercise the REAL campaignRouter through a tRPC caller with a fully-mocked
 * prisma. The actor is a superadmin so orgProcedure's membership gate and
 * requirePlan pass without DB/billing; isSuperAdmin is ONLY a plan exemption and
 * does NOT relax org-ownership scoping (the campaignId + organizationId filter on
 * updateMany, and the org-scoped findFirstOrThrow pre-check, are what enforce it).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// campaignRouter transitively imports @postautomation/queue (BullMQ/Redis at
// import time). setMonitoring never touches a queue, so stub it to stay offline.
vi.mock("@postautomation/queue", () => ({
  listeningSyncQueue: { add: vi.fn() },
  campaignAnalyticsSyncQueue: { add: vi.fn() },
  brandContentSyncQueue: { add: vi.fn() },
}));

import { createCallerFactory } from "../trpc";
import { campaignRouter } from "../routers/campaign.router";

const ORG_ID = "org-1";
const USER_ID = "user-1";

function baseMembership() {
  return {
    organizationMember: {
      findUnique: vi.fn(async () => ({ userId: USER_ID, organizationId: ORG_ID, role: "OWNER" })),
    },
  };
}

function session() {
  return { user: { id: USER_ID, email: "u@example.com", isSuperAdmin: true } } as any;
}

describe("campaign.setMonitoring (honest Monitoring toggle)", () => {
  beforeEach(() => vi.clearAllMocks());

  function buildCaller(opts: { campaignFound: boolean }) {
    const findFirstOrThrow = vi.fn(async (_args: any) => {
      if (!opts.campaignFound) throw new Error("No Campaign found");
      return { id: "campaign-1" };
    });
    const updateMany = vi.fn(async (_args: any) => ({ count: 3 }));
    const prisma = {
      ...baseMembership(),
      campaign: { findFirstOrThrow },
      brandTracker: { updateMany },
    } as any;
    const caller = createCallerFactory(campaignRouter)({
      prisma,
      session: session(),
      organizationId: ORG_ID,
    });
    return { caller, findFirstOrThrow, updateMany };
  }

  it("flips isActive on the campaign's trackers, scoped to campaignId + org (enable)", async () => {
    const { caller, findFirstOrThrow, updateMany } = buildCaller({ campaignFound: true });
    const res = await caller.setMonitoring({ id: "campaign-1", enabled: true });

    // Pre-check confirms the campaign belongs to the acting org before any write.
    expect(findFirstOrThrow).toHaveBeenCalledTimes(1);
    expect(findFirstOrThrow.mock.calls[0]![0].where).toEqual({ id: "campaign-1", organizationId: ORG_ID });

    // The real effect: every tracker in this campaign (org-scoped) gets isActive=true.
    expect(updateMany).toHaveBeenCalledTimes(1);
    const arg = updateMany.mock.calls[0]![0];
    expect(arg.where).toEqual({ campaignId: "campaign-1", organizationId: ORG_ID });
    expect(arg.data).toEqual({ isActive: true });
    expect(res).toEqual({ count: 3, enabled: true });
  });

  it("pauses monitoring by setting isActive=false (disable)", async () => {
    const { caller, updateMany } = buildCaller({ campaignFound: true });
    await caller.setMonitoring({ id: "campaign-1", enabled: false });
    expect(updateMany.mock.calls[0]![0].data).toEqual({ isActive: false });
  });

  it("throws (NOT_FOUND-equivalent) for a foreign/non-existent campaign WITHOUT touching trackers", async () => {
    const { caller, updateMany } = buildCaller({ campaignFound: false });
    await expect(
      caller.setMonitoring({ id: "campaign-other-org", enabled: true })
    ).rejects.toThrow();
    // The org-scoped pre-check fails first → no cross-org tracker write happens.
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("campaign.list derives honest monitoring state from tracker isActive", () => {
  beforeEach(() => vi.clearAllMocks());

  function buildCaller(campaigns: any[]) {
    const findMany = vi.fn(async (_args: any) => campaigns);
    const prisma = {
      ...baseMembership(),
      campaign: { findMany },
    } as any;
    const caller = createCallerFactory(campaignRouter)({
      prisma,
      session: session(),
      organizationId: ORG_ID,
    });
    return { caller, findMany };
  }

  it("reports monitoring=true and N/M counts when some trackers are active", async () => {
    const { caller } = buildCaller([
      {
        id: "c1",
        name: "Mixed",
        brandTrackers: [{ id: "t1", isActive: true }, { id: "t2", isActive: false }, { id: "t3", isActive: true }],
        _count: { campaignPosts: 0, brandTrackers: 3 },
      },
    ]);
    const res = await caller.list();
    expect(res[0]).toMatchObject({ monitoring: true, activeTrackers: 2, totalTrackers: 3 });
    // The raw brandTrackers array is stripped from the returned shape (counts only).
    expect((res[0] as any).brandTrackers).toBeUndefined();
  });

  it("reports monitoring=false when no trackers are active (or none exist)", async () => {
    const { caller } = buildCaller([
      { id: "c2", name: "Paused", brandTrackers: [{ id: "t", isActive: false }], _count: { campaignPosts: 0, brandTrackers: 1 } },
      { id: "c3", name: "Empty", brandTrackers: [], _count: { campaignPosts: 0, brandTrackers: 0 } },
    ]);
    const res = await caller.list();
    expect(res[0]).toMatchObject({ monitoring: false, activeTrackers: 0, totalTrackers: 1 });
    expect(res[1]).toMatchObject({ monitoring: false, activeTrackers: 0, totalTrackers: 0 });
  });
});
