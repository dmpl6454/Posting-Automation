/**
 * Regression guard for two cross-org IDOR gaps in chat.router.ts executeAction
 * (Phase 1, Task 5 — N7/N8).
 *
 * N7 update_agent: the update where-clause had NO organizationId, so an
 *   AI-driven action could mutate another org's agent (the thread is org-scoped
 *   but the agent record was not re-validated). Fixed by org-scoping the where.
 * N8 create_brand_tracker: an AI-supplied campaignId was written straight onto
 *   the new BrandTracker with NO check it belongs to the acting org — a cross-org
 *   association/leak. Fixed by verifying the campaign is in the org first.
 *
 * These exercise the REAL executeAction mutation through a tRPC caller with a
 * fully-mocked prisma. The actor is a superadmin so orgProcedure's membership
 * gate passes (mocked) and its plan-expiry read is skipped; isSuperAdmin is only
 * a plan/billing exemption and does NOT relax these org-ownership guards.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// chat.router transitively imports @postautomation/queue, which instantiates
// BullMQ queues (Redis) at import time. update_agent / create_brand_tracker
// never touch a queue, so stub the module to keep the test offline.
vi.mock("@postautomation/queue", () => ({
  agentRunQueue: { add: vi.fn() },
  postPublishQueue: { add: vi.fn() },
}));

import { createCallerFactory } from "../trpc";
import { chatRouter } from "../routers/chat.router";

const createCaller = createCallerFactory(chatRouter);

const ORG_ID = "org-1";
const USER_ID = "user-1";
const THREAD_ID = "thread-1";
const AGENT_ID = "agent-1";

type PrismaMock = {
  agentUpdate: ReturnType<typeof vi.fn>;
  campaignFindFirst: ReturnType<typeof vi.fn>;
  brandTrackerCreate: ReturnType<typeof vi.fn>;
};

function buildCaller(opts: {
  threadAgentId?: string | null;
  campaignFindFirst?: any;
}) {
  const agentUpdate = vi.fn(async ({ data }: any) => ({ id: AGENT_ID, ...data }));
  const campaignFindFirst = vi.fn(async () => opts.campaignFindFirst ?? null);
  const brandTrackerCreate = vi.fn(async ({ data }: any) => ({ id: "brand-1", ...data }));

  const prisma = {
    // orgProcedure membership gate (superadmin still requires a real membership)
    organizationMember: {
      findUnique: vi.fn(async () => ({ userId: USER_ID, organizationId: ORG_ID, role: "OWNER" })),
    },
    // executeAction's thread lookup
    chatThread: {
      findFirst: vi.fn(async () => ({
        id: THREAD_ID,
        organizationId: ORG_ID,
        agentId: opts.threadAgentId === undefined ? AGENT_ID : opts.threadAgentId,
      })),
    },
    agent: { update: agentUpdate },
    campaign: { findFirst: campaignFindFirst },
    brandTracker: { create: brandTrackerCreate },
    chatMessage: { create: vi.fn(async () => ({ id: "msg-1" })) },
  } as any;

  const caller = createCaller({
    prisma,
    session: { user: { id: USER_ID, email: "u@example.com", isSuperAdmin: true } } as any,
    organizationId: ORG_ID,
  });

  return { caller, mock: { agentUpdate, campaignFindFirst, brandTrackerCreate } as PrismaMock };
}

describe("executeAction cross-org IDOR guards (N7/N8)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("update_agent org-scopes the prisma.agent.update where clause", async () => {
    const { caller, mock } = buildCaller({});
    await caller.executeAction({
      threadId: THREAD_ID,
      actionType: "update_agent",
      payload: { name: "Renamed" },
    });
    expect(mock.agentUpdate).toHaveBeenCalledTimes(1);
    const arg = mock.agentUpdate.mock.calls[0][0];
    expect(arg.where).toMatchObject({ id: AGENT_ID, organizationId: ORG_ID });
  });

  it("create_brand_tracker rejects a foreign campaignId (findFirst -> null) and never creates", async () => {
    const { caller, mock } = buildCaller({ campaignFindFirst: null });
    await expect(
      caller.executeAction({
        threadId: THREAD_ID,
        actionType: "create_brand_tracker",
        payload: { brandName: "Acme", campaignId: "campaign-other-org" },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The campaign was looked up org-scoped...
    expect(mock.campaignFindFirst).toHaveBeenCalledTimes(1);
    expect(mock.campaignFindFirst.mock.calls[0][0].where).toMatchObject({
      id: "campaign-other-org",
      organizationId: ORG_ID,
    });
    // ...and no BrandTracker was written.
    expect(mock.brandTrackerCreate).not.toHaveBeenCalled();
  });

  it("create_brand_tracker proceeds when the campaignId belongs to the org", async () => {
    const { caller, mock } = buildCaller({
      campaignFindFirst: { id: "campaign-mine", organizationId: ORG_ID },
    });
    const res = await caller.executeAction({
      threadId: THREAD_ID,
      actionType: "create_brand_tracker",
      payload: { brandName: "Acme", campaignId: "campaign-mine" },
    });
    expect(res).toMatchObject({ type: "brand_tracker_created" });
    expect(mock.brandTrackerCreate).toHaveBeenCalledTimes(1);
    expect(mock.brandTrackerCreate.mock.calls[0][0].data).toMatchObject({
      organizationId: ORG_ID,
      campaignId: "campaign-mine",
    });
  });

  it("create_brand_tracker with NO campaignId skips the campaign check and creates (campaignId undefined)", async () => {
    const { caller, mock } = buildCaller({});
    const res = await caller.executeAction({
      threadId: THREAD_ID,
      actionType: "create_brand_tracker",
      payload: { brandName: "Acme" },
    });
    expect(res).toMatchObject({ type: "brand_tracker_created" });
    expect(mock.campaignFindFirst).not.toHaveBeenCalled();
    expect(mock.brandTrackerCreate).toHaveBeenCalledTimes(1);
    expect(mock.brandTrackerCreate.mock.calls[0][0].data.campaignId).toBeUndefined();
  });
});
