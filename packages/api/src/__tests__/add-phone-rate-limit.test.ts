/**
 * user.addPhone sends a real SMS to WHATEVER phone number the caller supplies
 * (security audit 2026-09-28). It is a protectedProcedure (any signed-up
 * account) with no rate limit, so one account could drive the operator's SMS
 * bill up by targeting premium-rate or international numbers ("SMS toll
 * fraud"), or spam a real person's phone with codes they never asked for.
 *
 * A signed-in user only ever needs to verify a handful of numbers; the limiter
 * bounds that without affecting normal use.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendSms } = vi.hoisted(() => ({ sendSms: vi.fn(async (_to: string, _body: string) => {}) }));
vi.mock("../lib/sms", () => ({ sendSms }));
vi.mock("../lib/audit", () => ({ createAuditLog: vi.fn(async () => {}), AUDIT_ACTIONS: { USER_PHONE_ADDED: "x" } }));

const userFindUnique = vi.fn(async () => null); // phone not taken
const phoneOtpDeleteMany = vi.fn(async () => ({ count: 0 }));
const phoneOtpCreate = vi.fn(async () => ({}));

import { createCallerFactory } from "../trpc";
import { userRouter } from "../routers/user.router";

const caller = (userId = "user-1") =>
  createCallerFactory(userRouter)({
    prisma: {
      user: { findUnique: userFindUnique },
      phoneOtp: { deleteMany: phoneOtpDeleteMany, create: phoneOtpCreate },
    } as any,
    organizationId: "org-1",
    session: { user: { id: userId, email: "a@b.c", isSuperAdmin: false }, expires: "2099-01-01" } as any,
  });

beforeEach(() => vi.clearAllMocks());

describe("user.addPhone rate limit", () => {
  it("refuses after a small number of sends in a window, regardless of destination number", async () => {
    let sent = 0;
    let refused = 0;
    for (let i = 0; i < 10; i++) {
      try {
        await caller().addPhone({ phone: `+1555000${1000 + i}` });
        sent++;
      } catch (e: any) {
        expect(e.code).toBe("TOO_MANY_REQUESTS");
        refused++;
      }
    }
    expect(sendSms).toHaveBeenCalledTimes(sent);
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(10); // NOT unlimited — the whole point
    expect(refused).toBeGreaterThan(0);
  });

  it("also caps sends to ONE number across many accounts (each under its own per-user limit)", async () => {
    const target = "+15559990000";
    let sent = 0;
    for (let i = 0; i < 8; i++) {
      try {
        await caller(`spammer-${i}`).addPhone({ phone: target });
        sent++;
      } catch (e: any) {
        expect(e.code).toBe("TOO_MANY_REQUESTS");
      }
    }
    expect(sent).toBe(5);
    expect(sendSms.mock.calls.filter(([to]) => to === target)).toHaveLength(5);
  });
});
