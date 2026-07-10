/**
 * BO-04: gate manual outcome logging (REPLIED/INTERESTED/NOT_INTERESTED/CLOSED)
 * until the lead has actually been SENT.
 *
 * Background: brandLeads.setStatus (gap #3, see brand-leads-set-status.test.ts)
 * only accepts the 4 post-send manual outcomes, but had no precondition on the
 * lead's CURRENT status — a lead still PENDING/APPROVED (nothing ever sent)
 * could be marked "Replied", producing logically inconsistent funnel data.
 *
 * "SENT" is the same authoritative signal the outreach-send worker uses via
 * reconcileLeadStatus (apps/worker/src/workers/lib/lead-status.ts): at least
 * one channel delivered. This test exercises the REAL brandLeadsRouter through
 * a tRPC caller with a fully-mocked prisma, mirroring the pattern in
 * campaign-set-monitoring.test.ts.
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

function buildCaller(leadStatus: string) {
  const findFirstOrThrow = vi.fn(async (_args: any) => ({
    id: "l1",
    status: leadStatus,
  }));
  const update = vi.fn(async (args: any) => ({ id: "l1", status: args.data.status }));
  const prisma = {
    ...baseMembership(),
    outreachLead: { findFirstOrThrow, update },
  } as any;
  const caller = createCallerFactory(brandLeadsRouter)({
    prisma,
    session: session(),
    organizationId: ORG_ID,
  });
  return { caller, findFirstOrThrow, update };
}

describe("brandLeads.setStatus gates manual outcomes until sent (BO-04)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a manual outcome before the lead has been sent (PENDING)", async () => {
    const { caller, update } = buildCaller("PENDING");
    await expect(
      caller.setStatus({ leadId: "l1", status: "REPLIED" })
    ).rejects.toThrow(/before outreach has been sent/i);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a manual outcome when the lead is only APPROVED (not yet sent)", async () => {
    const { caller, update } = buildCaller("APPROVED");
    await expect(
      caller.setStatus({ leadId: "l1", status: "INTERESTED" })
    ).rejects.toThrow(/before outreach has been sent/i);
    expect(update).not.toHaveBeenCalled();
  });

  it("allows a manual outcome after the lead has been sent (SENT)", async () => {
    const { caller, update } = buildCaller("SENT");
    const res = await caller.setStatus({ leadId: "l1", status: "REPLIED" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0].where).toEqual({ id: "l1" });
    expect(update.mock.calls[0]![0].data).toEqual({ status: "REPLIED" });
    expect(res).toEqual({ id: "l1", status: "REPLIED" });
  });
});
