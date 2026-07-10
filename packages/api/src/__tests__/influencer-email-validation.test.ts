/**
 * CM-01 — validate influencer email format.
 *
 * Background: campaign.router.ts's createInfluencer/updateInfluencer accepted
 * `contactEmail` as a bare `z.string()` with no format validation, so a
 * malformed value like "not-an-email" was persisted as-is. That bad data later
 * feeds outreach flows (outreach-poll/outreach-send workers), where a garbage
 * address fails far from the cause. Fix: `.email()` validation on both
 * mutations, `.or(z.literal(""))` so omission AND an explicit empty string
 * (clearing the field) both still work — only a non-empty malformed string is
 * rejected, and it's rejected by Zod BEFORE prisma is ever touched.
 *
 * These exercise the REAL campaignRouter through a tRPC caller with a fully
 * mocked prisma, mirroring the harness in campaign-set-monitoring.test.ts:
 * organizationMember.findUnique backs orgProcedure's membership gate, and the
 * actor is a superadmin so gateCampaigns's requirePlan (PROFESSIONAL) passes
 * without a billing/plan DB read.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// campaignRouter transitively imports @postautomation/queue (BullMQ/Redis at
// import time). Influencer mutations never touch a queue, so stub it to stay
// offline, mirroring other router tests in this suite.
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

describe("campaign.createInfluencer contactEmail validation", () => {
  beforeEach(() => vi.clearAllMocks());

  function buildCaller() {
    const create = vi.fn(async (_args: any) => ({ id: "inf-1" }));
    const prisma = {
      ...baseMembership(),
      influencer: { create },
    } as any;
    const caller = createCallerFactory(campaignRouter)({
      prisma,
      session: session(),
      organizationId: ORG_ID,
    });
    return { caller, create };
  }

  it("rejects a malformed contactEmail before prisma is touched", async () => {
    const { caller, create } = buildCaller();
    await expect(
      caller.createInfluencer({
        name: "X",
        platform: "instagram",
        handle: "@x",
        contactEmail: "not-an-email",
      })
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it("accepts a valid contactEmail", async () => {
    const { caller, create } = buildCaller();
    await caller.createInfluencer({
      name: "X",
      platform: "instagram",
      handle: "@x",
      contactEmail: "a@b.com",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("accepts an omitted contactEmail", async () => {
    const { caller, create } = buildCaller();
    await caller.createInfluencer({
      name: "Y",
      platform: "instagram",
      handle: "@y",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("accepts an explicit empty-string contactEmail (clearing the field)", async () => {
    const { caller, create } = buildCaller();
    await caller.createInfluencer({
      name: "Z",
      platform: "instagram",
      handle: "@z",
      contactEmail: "",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("campaign.updateInfluencer contactEmail validation", () => {
  beforeEach(() => vi.clearAllMocks());

  function buildCaller() {
    const updateMany = vi.fn(async (_args: any) => ({ count: 1 }));
    const findFirstOrThrow = vi.fn(async (_args: any) => ({ id: "inf-1" }));
    const prisma = {
      ...baseMembership(),
      influencer: { updateMany, findFirstOrThrow },
    } as any;
    const caller = createCallerFactory(campaignRouter)({
      prisma,
      session: session(),
      organizationId: ORG_ID,
    });
    return { caller, updateMany, findFirstOrThrow };
  }

  it("rejects a malformed contactEmail before prisma is touched", async () => {
    const { caller, updateMany } = buildCaller();
    await expect(
      caller.updateInfluencer({ id: "inf-1", contactEmail: "not-an-email" })
    ).rejects.toThrow();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("accepts a valid contactEmail", async () => {
    const { caller, updateMany } = buildCaller();
    await caller.updateInfluencer({ id: "inf-1", contactEmail: "a@b.com" });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("accepts an omitted contactEmail", async () => {
    const { caller, updateMany } = buildCaller();
    await caller.updateInfluencer({ id: "inf-1", notes: "hi" });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("accepts null and an explicit empty-string contactEmail (clearing the field)", async () => {
    const { caller, updateMany } = buildCaller();
    await caller.updateInfluencer({ id: "inf-1", contactEmail: null });
    await caller.updateInfluencer({ id: "inf-1", contactEmail: "" });
    expect(updateMany).toHaveBeenCalledTimes(2);
  });
});
