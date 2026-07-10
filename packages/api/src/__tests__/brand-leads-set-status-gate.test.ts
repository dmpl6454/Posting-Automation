/**
 * BO-04: gate manual outcome logging (REPLIED/INTERESTED/NOT_INTERESTED/CLOSED)
 * until the lead has actually been sent at least once.
 *
 * Background: brandLeads.setStatus (gap #3, see brand-leads-set-status.test.ts)
 * only accepts the 4 post-send manual outcomes, but had no precondition on
 * whether outreach was ever sent — a lead still PENDING/APPROVED (nothing ever
 * sent) could be marked "Replied", producing logically inconsistent funnel data.
 *
 * ⚠️ Cross-task interaction fix (found during final holistic review of this
 * branch): the original BO-04 gate checked the lead's CURRENT `lead.status !==
 * "SENT"`. BO-03 (aa5fdfd) made setStatus's onSuccess patch `lead.status` to
 * the just-logged outcome (e.g. "REPLIED") client-side, and the same outcome
 * is written server-side too — so after the FIRST successful outcome click,
 * `lead.status` is no longer "SENT" and the old gate would reject EVERY
 * subsequent setStatus call forever, even though outreach genuinely was sent.
 * Fixed by gating on an append-only historical fact instead: whether an
 * OutreachMessage for this lead ever reached "SENT" (the same authoritative
 * signal the outreach-send worker uses via reconcileLeadStatus,
 * apps/worker/src/workers/lib/lead-status.ts) — once true, always true,
 * regardless of how many times `lead.status` is subsequently changed.
 *
 * This test exercises the REAL brandLeadsRouter through a tRPC caller with a
 * fully-mocked prisma, mirroring the pattern in campaign-set-monitoring.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { createCallerFactory } from "../trpc";
import { brandLeadsRouter } from "../routers/brand-leads.router";

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

function buildCaller(leadStatus: string, sentMessageCount: number) {
  const findFirstOrThrow = vi.fn(async (_args: any) => ({
    id: "l1",
    status: leadStatus,
  }));
  const update = vi.fn(async (args: any) => ({ id: "l1", status: args.data.status }));
  const count = vi.fn(async (_args: any) => sentMessageCount);
  const prisma = {
    ...baseMembership(),
    outreachLead: { findFirstOrThrow, update },
    outreachMessage: { count },
  } as any;
  const caller = createCallerFactory(brandLeadsRouter)({
    prisma,
    session: session(),
    organizationId: ORG_ID,
  });
  return { caller, findFirstOrThrow, update, count };
}

describe("brandLeads.setStatus gates manual outcomes until sent (BO-04)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a manual outcome before the lead has been sent (PENDING, zero sent messages)", async () => {
    const { caller, update, count } = buildCaller("PENDING", 0);
    await expect(
      caller.setStatus({ leadId: "l1", status: "REPLIED" })
    ).rejects.toThrow(/before outreach has been sent/i);
    expect(update).not.toHaveBeenCalled();
    expect(count).toHaveBeenCalledWith({ where: { leadId: "l1", status: "SENT" } });
  });

  it("rejects a manual outcome when the lead is only APPROVED (not yet sent, zero sent messages)", async () => {
    const { caller, update } = buildCaller("APPROVED", 0);
    await expect(
      caller.setStatus({ leadId: "l1", status: "INTERESTED" })
    ).rejects.toThrow(/before outreach has been sent/i);
    expect(update).not.toHaveBeenCalled();
  });

  it("allows a manual outcome after the lead has been sent (SENT, one sent message)", async () => {
    const { caller, update } = buildCaller("SENT", 1);
    const res = await caller.setStatus({ leadId: "l1", status: "REPLIED" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0].where).toEqual({ id: "l1" });
    expect(update.mock.calls[0]![0].data).toEqual({ status: "REPLIED" });
    expect(res).toEqual({ id: "l1", status: "REPLIED" });
  });

  // ⚠️ Regression test for the exact BO-03/BO-04 lockout bug found in final
  // review: a lead whose CURRENT status is already "REPLIED" (an outcome was
  // already logged once, e.g. by BO-03's onSuccess patch) must STILL be able
  // to have setStatus called again — because a message for it once reached
  // SENT, that fact never goes away, even though `lead.status` itself is no
  // longer "SENT".
  it("allows logging a SECOND, different outcome on a lead whose status is already REPLIED (not SENT)", async () => {
    const { caller, update, count } = buildCaller("REPLIED", 1);
    const res = await caller.setStatus({ leadId: "l1", status: "CLOSED" });
    expect(count).toHaveBeenCalledWith({ where: { leadId: "l1", status: "SENT" } });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0].data).toEqual({ status: "CLOSED" });
    expect(res).toEqual({ id: "l1", status: "CLOSED" });
  });
});
