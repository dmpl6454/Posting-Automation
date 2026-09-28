/**
 * user.verifyPhone / user.removePhone route through the SAME attempt-limited
 * check as NextAuth login (security audit 2026-09-28, packages/db/src/verify-phone-otp.ts).
 * This is the router-level proof: a caller who keeps guessing wrong gets locked
 * out before they can ever land the real code, on BOTH procedures.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("../lib/sms", () => ({ sendSms: vi.fn(async () => {}) }));
vi.mock("../lib/audit", () => ({ createAuditLog: vi.fn(async () => {}), AUDIT_ACTIONS: { USER_PHONE_ADDED: "x", USER_PHONE_REMOVED: "y" } }));

const otpState: { id: string; phone: string; otp: string; attempts: number; used: boolean; expiresAt: Date } = {
  id: "otp-1",
  phone: "+15551234567",
  otp: "",
  attempts: 0,
  used: false,
  expiresAt: new Date(Date.now() + 60_000),
};

const phoneOtpFindFirst = vi.fn(async (args: any) =>
  !otpState.used && otpState.expiresAt > new Date() && args.where.phone === otpState.phone ? { ...otpState } : null
);
const phoneOtpUpdateMany = vi.fn(async (args: any) => {
  if (args.where.id !== otpState.id) return { count: 0 };
  if ("attempts" in args.where && otpState.attempts >= args.where.attempts.lt) return { count: 0 };
  if ("used" in args.where && otpState.used !== args.where.used) return { count: 0 };
  if (args.data.attempts?.increment) otpState.attempts += args.data.attempts.increment;
  if (args.data.used) otpState.used = true;
  return { count: 1 };
});

const userFindUnique = vi.fn(async () => ({ id: "user-1", phone: otpState.phone }));
const userUpdate = vi.fn(async () => ({}));

vi.mock("@postautomation/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@postautomation/db")>();
  return { ...actual };
});

import { createCallerFactory } from "../trpc";
import { userRouter } from "../routers/user.router";

const caller = () =>
  createCallerFactory(userRouter)({
    prisma: {
      phoneOtp: { findFirst: phoneOtpFindFirst, updateMany: phoneOtpUpdateMany },
      user: { findUnique: userFindUnique, update: userUpdate },
    } as any,
    organizationId: "org-1",
    session: { user: { id: "user-1", email: "a@b.c", isSuperAdmin: false }, expires: "2099-01-01" } as any,
  });

beforeEach(async () => {
  vi.clearAllMocks();
  otpState.otp = await bcrypt.hash("482913", 8);
  otpState.attempts = 0;
  otpState.used = false;
  otpState.expiresAt = new Date(Date.now() + 60_000);
});

describe("user.verifyPhone", () => {
  it("locks out after repeated wrong codes — the real code stops working too", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(caller().verifyPhone({ phone: otpState.phone, otp: "000000" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    await expect(caller().verifyPhone({ phone: otpState.phone, otp: "482913" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Too many"),
    });
  });

  it("still accepts the correct code within the attempt budget", async () => {
    await expect(caller().verifyPhone({ phone: otpState.phone, otp: "482913" })).resolves.toMatchObject({
      success: true,
    });
  });
});

describe("user.removePhone", () => {
  it("locks out after repeated wrong codes", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(caller().removePhone({ otp: "000000" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await expect(caller().removePhone({ otp: "482913" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Too many"),
    });
  });
});
