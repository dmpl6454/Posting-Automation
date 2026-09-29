/**
 * verifyPhone gave the account owner zero signal that a phone login method
 * had been attached/replaced (security audit 2026-09-28, confirmed by
 * dedicated investigation). Attacker chain: hijack a session, addPhone +
 * verifyPhone the attacker's own number (now step-up gated for a REPLACE —
 * see phone-replace-step-up.test.ts), and the real owner never finds out a
 * second login method now exists on their account.
 *
 * Fix: a notification email now goes to the account's REGISTERED email on
 * every successful verifyPhone — sent to ctx.session.user.email, which is
 * always the real account's address regardless of which session (owner's or
 * an attacker's hijacked one) is currently acting as that account, so it
 * reaches the real owner even in the attack scenario. Best-effort — a mail
 * failure must never fail the phone verification itself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("../lib/audit", () => ({ createAuditLog: vi.fn(async () => {}), AUDIT_ACTIONS: { USER_PHONE_ADDED: "x" } }));

const sendEmail = vi.fn(async (..._a: any[]) => {});
vi.mock("../lib/email", () => ({ sendEmail: (...a: any[]) => sendEmail(...a) }));

const PHONE = "+15551234567";
const otpState = { id: "otp-1", phone: PHONE, otp: "", attempts: 0, used: false, expiresAt: new Date(Date.now() + 60_000) };

const phoneOtpFindFirst = vi.fn(async (args: any) =>
  !otpState.used && otpState.expiresAt > new Date() && args.where.phone === otpState.phone ? { ...otpState } : null
);
const phoneOtpUpdateMany = vi.fn(async (args: any) => {
  if (args.where.id !== otpState.id) return { count: 0 };
  if (args.data.used) otpState.used = true;
  return { count: 1 };
});
const userUpdate = vi.fn(async () => ({}));

import { createCallerFactory } from "../trpc";
import { userRouter } from "../routers/user.router";

const caller = () =>
  createCallerFactory(userRouter)({
    prisma: {
      phoneOtp: { findFirst: phoneOtpFindFirst, updateMany: phoneOtpUpdateMany },
      user: { update: userUpdate },
    } as any,
    organizationId: "org-1",
    session: { user: { id: "user-1", email: "owner@example.com", isSuperAdmin: false }, expires: "2099-01-01" } as any,
  });

beforeEach(async () => {
  vi.clearAllMocks();
  otpState.otp = await bcrypt.hash("482913", 8);
  otpState.attempts = 0;
  otpState.used = false;
  otpState.expiresAt = new Date(Date.now() + 60_000);
});

describe("user.verifyPhone — notifies the account's real owner", () => {
  it("emails the account's registered address on a successful verify", async () => {
    await expect(caller().verifyPhone({ phone: PHONE, otp: "482913" })).resolves.toMatchObject({ success: true });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const call = sendEmail.mock.calls[0]![0];
    expect(call.to).toBe("owner@example.com");
    expect(call.subject.toLowerCase()).toContain("phone");
  });

  it("a mail failure never fails the phone verification itself", async () => {
    sendEmail.mockRejectedValueOnce(new Error("smtp down"));
    await expect(caller().verifyPhone({ phone: PHONE, otp: "482913" })).resolves.toMatchObject({ success: true });
  });
});
