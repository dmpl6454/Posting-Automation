/**
 * auth.sendPhoneOtp is public and used to issue a fresh login code on every
 * call (security review 2026-10-01). Each new PhoneOtp row starts at
 * attempts = 0, so send -> 5 guesses -> send -> 5 guesses ... reset the
 * attempt limit in verify-phone-otp.ts for free, forever.
 *
 * Fix: a per-PHONE issuance cap inside the handler (not the session-keyed
 * middleware — every anonymous caller would share one bucket). Over the cap it
 * still answers { success: true } without sending, so it never reveals whether
 * the number belongs to an account.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const { sendSms } = vi.hoisted(() => ({ sendSms: vi.fn(async (_to: string, _body: string) => {}) }));
vi.mock("../lib/sms", () => ({ sendSms }));
vi.mock("../lib/email", () => ({ sendEmail: vi.fn(async (..._a: any[]) => {}) }));

const VERIFIED = new Set(["+15550100001", "+15550100002", "+15550100003"]);
const userFindUnique = vi.fn(async (args: any) =>
  VERIFIED.has(args.where.phone) ? { id: `owner-of-${args.where.phone}`, isBanned: false, phoneVerified: new Date() } : null
);
const phoneOtpDeleteMany = vi.fn(async (..._a: any[]) => ({ count: 0 }));
const phoneOtpCreate = vi.fn(async (..._a: any[]) => ({}));

import { createCallerFactory } from "../trpc";
import { authRouter } from "../routers/auth.router";

const caller = () =>
  createCallerFactory(authRouter)({
    prisma: {
      user: { findUnique: userFindUnique },
      phoneOtp: { deleteMany: phoneOtpDeleteMany, create: phoneOtpCreate },
    } as any,
    session: null,
  });

beforeAll(() => {
  process.env.FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY || "test-key";
});
beforeEach(() => vi.clearAllMocks());

describe("auth.sendPhoneOtp per-phone issuance cap", () => {
  it("stops issuing fresh codes for one phone after a few sends, while still answering success", async () => {
    for (let i = 0; i < 12; i++) {
      await expect(caller().sendPhoneOtp({ phone: "+15550100001" })).resolves.toEqual({ success: true });
    }
    expect(sendSms).toHaveBeenCalledTimes(5);
    expect(phoneOtpCreate).toHaveBeenCalledTimes(5);
  });

  it("keys the cap on the normalized number, so formatting variants share one budget", async () => {
    for (let i = 0; i < 4; i++) await caller().sendPhoneOtp({ phone: "+15550100002" });
    VERIFIED.add("+1 555 010 0002");
    for (let i = 0; i < 4; i++) await caller().sendPhoneOtp({ phone: "+1 555 010 0002" });
    expect(sendSms).toHaveBeenCalledTimes(5);
  });

  it("a different phone keeps its own budget", async () => {
    await expect(caller().sendPhoneOtp({ phone: "+15550100003" })).resolves.toEqual({ success: true });
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it("issues a LOGIN-purpose code bound to the phone's owner, and only clears earlier login codes", async () => {
    await caller().sendPhoneOtp({ phone: "+15550100003" });
    expect(phoneOtpCreate.mock.calls[0]![0].data).toMatchObject({
      phone: "+15550100003",
      purpose: "login",
      userId: "owner-of-+15550100003",
    });
    expect(phoneOtpDeleteMany.mock.calls[0]![0].where).toEqual({ phone: "+15550100003", purpose: "login" });
  });
});
