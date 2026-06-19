/**
 * Regression guard for two cross-org IDOR gaps surfaced by the 2026-06-19 audit.
 *
 * H6 listening.volumeOverTime: when a queryId was supplied the where-filter was a
 *   bare { listeningQueryId }, dropping the org scope that every sibling query
 *   (mentions, sentimentOverview) enforces — so a user could read another org's
 *   mention volume/sentiment timeline by passing a foreign listeningQueryId.
 *   Fixed by always anchoring the relation to the acting org's listeningQuery.
 *
 * M22 campaign.brandContent: when a brandTrackerId was supplied the where had no
 *   org scope (the campaignId / default branches scope via brandTracker.
 *   organizationId, but the brandTrackerId branch did not) — a cross-tenant read.
 *   Fixed by always requiring brandTracker.organizationId === acting org.
 *
 * These exercise the REAL routers through a tRPC caller with a fully-mocked
 * prisma. The actor is a superadmin so orgProcedure's membership gate and
 * requirePlan pass without DB/billing; isSuperAdmin is only a plan exemption and
 * does NOT relax org-ownership scoping.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Both routers transitively import @postautomation/queue, which instantiates
// BullMQ queues (Redis) at import time. The audited read-paths never touch a
// queue, so stub the module to keep the test offline.
vi.mock("@postautomation/queue", () => ({
  listeningSyncQueue: { add: vi.fn() },
  campaignAnalyticsSyncQueue: { add: vi.fn() },
  brandContentSyncQueue: { add: vi.fn() },
}));

import { createCallerFactory } from "../trpc";
import { listeningRouter } from "../routers/listening.router";
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

describe("listening.volumeOverTime cross-org IDOR guard (H6)", () => {
  beforeEach(() => vi.clearAllMocks());

  function buildCaller() {
    const mentionFindMany = vi.fn(async (_args: any) => [] as any[]);
    const prisma = {
      ...baseMembership(),
      mention: { findMany: mentionFindMany },
    } as any;
    const caller = createCallerFactory(listeningRouter)({
      prisma,
      session: session(),
      organizationId: ORG_ID,
    });
    return { caller, mentionFindMany };
  }

  it("org-scopes the mention.findMany where even when a queryId is supplied", async () => {
    const { caller, mentionFindMany } = buildCaller();
    await caller.volumeOverTime({ queryId: "query-other-org", days: 7 });
    expect(mentionFindMany).toHaveBeenCalledTimes(1);
    const where = mentionFindMany.mock.calls[0]![0].where;
    // Must keep the queryId filter AND anchor it to the acting org.
    expect(where.listeningQueryId).toBe("query-other-org");
    expect(where.listeningQuery).toMatchObject({ organizationId: ORG_ID });
  });

  it("still org-scopes when no queryId is supplied (unchanged behavior)", async () => {
    const { caller, mentionFindMany } = buildCaller();
    await caller.volumeOverTime({ days: 7 });
    const where = mentionFindMany.mock.calls[0]![0].where;
    expect(where.listeningQuery).toMatchObject({ organizationId: ORG_ID });
  });
});

describe("campaign.brandContent cross-org IDOR guard (M22)", () => {
  beforeEach(() => vi.clearAllMocks());

  function buildCaller() {
    const brandContentFindMany = vi.fn(async (_args: any) => [] as any[]);
    const prisma = {
      ...baseMembership(),
      brandContent: { findMany: brandContentFindMany },
    } as any;
    const caller = createCallerFactory(campaignRouter)({
      prisma,
      session: session(),
      organizationId: ORG_ID,
    });
    return { caller, brandContentFindMany };
  }

  it("org-scopes the brandContent.findMany where even when a brandTrackerId is supplied", async () => {
    const { caller, brandContentFindMany } = buildCaller();
    await caller.brandContent({ brandTrackerId: "tracker-other-org", limit: 10 });
    expect(brandContentFindMany).toHaveBeenCalledTimes(1);
    const where = brandContentFindMany.mock.calls[0]![0].where;
    // Must keep the brandTrackerId filter AND anchor it to the acting org's tracker.
    expect(where.brandTrackerId).toBe("tracker-other-org");
    expect(where.brandTracker).toMatchObject({ organizationId: ORG_ID });
  });

  it("still org-scopes via campaignId branch (unchanged behavior)", async () => {
    const { caller, brandContentFindMany } = buildCaller();
    await caller.brandContent({ campaignId: "campaign-1", limit: 10 });
    const where = brandContentFindMany.mock.calls[0]![0].where;
    expect(where.brandTracker).toMatchObject({ campaignId: "campaign-1", organizationId: ORG_ID });
  });

  it("still org-scopes the default (no filter) branch (unchanged behavior)", async () => {
    const { caller, brandContentFindMany } = buildCaller();
    await caller.brandContent({ limit: 10 });
    const where = brandContentFindMany.mock.calls[0]![0].where;
    expect(where.brandTracker).toMatchObject({ organizationId: ORG_ID });
  });
});
