/**
 * Regression guard for approval.submit (APPR-1).
 *
 * Part A — schema contract: ensures the zod input rejects empty reviewerIds
 * and accepts a valid shape (mirrors the schema in approval.router.ts:8-11).
 *
 * Part B — resolver behavior: uses the createCaller pattern (same as
 * chat-action-idor.test.ts) to assert that a successful submit invokes
 * prisma.approvalRequest.create once and prisma.notification.create once.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// ─── Schema-contract tests ───────────────────────────────────────────────────

// Mirror of approval.submit's input schema (approval.router.ts:8-11).
const submitInput = z.object({
  postId: z.string(),
  reviewerIds: z.array(z.string()).min(1),
});

describe("approval.submit input contract (APPR-1)", () => {
  it("rejects an empty reviewerIds array", () => {
    expect(
      submitInput.safeParse({ postId: "p1", reviewerIds: [] }).success
    ).toBe(false);
  });
  it("accepts a valid postId + at least one reviewer", () => {
    const r = submitInput.safeParse({ postId: "p1", reviewerIds: ["u1"] });
    expect(r.success).toBe(true);
  });
});

// ─── Resolver-behaviour tests (mocked prisma via createCaller) ────────────────

import { createCallerFactory } from "../trpc";
import { approvalRouter } from "../routers/approval.router";

const createCaller = createCallerFactory(approvalRouter);

const ORG_ID = "org-1";
const USER_ID = "user-1";

function buildCaller() {
  const approvalRequestCreate = vi.fn(async (args: any) => ({
    id: "req-1",
    ...args.data,
    steps: (args.data.steps?.create ?? []).map((s: any, i: number) => ({
      id: `step-${i}`,
      ...s,
    })),
  }));
  const notificationCreate = vi.fn(async () => ({ id: "notif-1" }));

  const prisma = {
    // orgProcedure membership gate
    organizationMember: {
      findUnique: vi.fn(async () => ({
        userId: USER_ID,
        organizationId: ORG_ID,
        role: "OWNER",
      })),
    },
    // submit: org-owned post exists
    post: {
      findFirst: vi.fn(async () => ({
        id: "p1",
        organizationId: ORG_ID,
        status: "DRAFT",
      })),
    },
    // submit: no existing pending request
    approvalRequest: {
      findFirst: vi.fn(async () => null),
      create: approvalRequestCreate,
    },
    // submit: notify first reviewer
    notification: {
      create: notificationCreate,
    },
    // orgProcedure plan-expiry check
    organization: {
      findUnique: vi.fn(async () => ({ plan: "PROFESSIONAL", planExpiresAt: null })),
    },
  } as any;

  const caller = createCaller({
    prisma,
    session: {
      user: { id: USER_ID, email: "u@example.com", isSuperAdmin: false },
    } as any,
    organizationId: ORG_ID,
  });

  return { caller, approvalRequestCreate, notificationCreate };
}

describe("approval.submit resolver behaviour (APPR-1)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates an approvalRequest and notifies the first reviewer", async () => {
    const { caller, approvalRequestCreate, notificationCreate } = buildCaller();

    const result = await caller.submit({ postId: "p1", reviewerIds: ["u1", "u2"] });

    expect(approvalRequestCreate).toHaveBeenCalledOnce();
    const createArg = approvalRequestCreate.mock.calls[0]![0];
    expect(createArg.data.postId).toBe("p1");
    expect(createArg.data.requestedById).toBe(USER_ID);
    expect(createArg.data.totalSteps).toBe(2);

    expect(notificationCreate).toHaveBeenCalledOnce();
    const notifArg = (notificationCreate.mock.calls[0] as any[])[0] as any;
    expect(notifArg.data.userId).toBe("u1"); // first reviewer
    expect(notifArg.data.type).toBe("approval.requested");

    expect(result.id).toBe("req-1");
  });
});
