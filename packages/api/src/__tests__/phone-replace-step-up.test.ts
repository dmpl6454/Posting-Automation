/**
 * addPhone/verifyPhone could silently REPLACE an already-verified phone with
 * a completely different one, using nothing but an active session — no
 * current-password, no re-auth of any kind, no notification to the account's
 * real owner (security audit 2026-09-28, confirmed by dedicated
 * investigation).
 *
 * Concrete attack chain the investigation traced: attacker hijacks a live
 * session (stolen cookie, XSS, unlocked device — session maxAge is 30 days)
 * -> calls addPhone with their own number -> verifyPhone completes with an
 * OTP sent to THEIR phone -> the victim's User row now has phone = attacker's
 * number, permanently, with zero signal to the victim. Even resetting the
 * password afterward did not undo it (separately fixed — see
 * resetPassword-clears-phone.test.ts) — the attacker could still sign in via
 * phone-otp using the number they attached.
 *
 * Fix, at the earliest possible point (addPhone, before any OTP is even
 * sent): if the caller ALREADY has a different verified phone, replacing it
 * requires step-up — currentPassword (same bcrypt-compare pattern
 * changePassword already uses) for an account that has one, or an explicit
 * refusal pointing at removePhone (which already requires a fresh OTP to the
 * OLD phone) for an OAuth-only account that has none. A first-time add (no
 * existing phone) keeps the lighter bar — no barrier needed to attach a
 * phone that doesn't exist yet.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("../lib/sms", () => ({ sendSms: vi.fn(async () => {}) }));
vi.mock("../lib/audit", () => ({ createAuditLog: vi.fn(async () => {}), AUDIT_ACTIONS: { USER_PHONE_ADDED: "x" } }));
// The real addPhoneOtpRateLimiter (3/hour) is covered by add-phone-rate-limit.test.ts;
// bypass it here so this file's own assertions aren't order-dependent on call count.
vi.mock("../middleware/rate-limit.middleware", () => ({
  createRateLimitMiddleware: () => ({ next }: { next: () => Promise<any> }) => next(),
}));

const userFindUnique = vi.fn();
const phoneOtpDeleteMany = vi.fn(async () => ({ count: 0 }));
const phoneOtpCreate = vi.fn(async () => ({}));

import { createCallerFactory } from "../trpc";
import { userRouter } from "../routers/user.router";

const caller = () =>
  createCallerFactory(userRouter)({
    prisma: {
      user: { findUnique: userFindUnique },
      phoneOtp: { deleteMany: phoneOtpDeleteMany, create: phoneOtpCreate },
    } as any,
    organizationId: "org-1",
    session: { user: { id: "user-1", email: "a@b.c", isSuperAdmin: false }, expires: "2099-01-01" } as any,
  });

beforeEach(() => vi.clearAllMocks());

describe("user.addPhone — replacing an existing phone requires step-up", () => {
  it("first-time add (no existing phone) needs no currentPassword", async () => {
    // Called twice by addPhone: once by phone (uniqueness), once by userId (self-lookup).
    userFindUnique.mockImplementation(async (args: any) =>
      args.where.id === "user-1" ? { id: "user-1", phone: null, password: "hash" } : null
    );
    await expect(caller().addPhone({ phone: "+15550001111" })).resolves.toEqual({ success: true });
  });

  it("re-verifying the SAME phone number needs no currentPassword", async () => {
    userFindUnique.mockImplementation(async (args: any) =>
      args.where.id === "user-1" ? { id: "user-1", phone: "+15550001111", password: "hash" } : null
    );
    await expect(caller().addPhone({ phone: "+15550001111" })).resolves.toEqual({ success: true });
  });

  it("replacing a DIFFERENT phone refuses without currentPassword", async () => {
    userFindUnique.mockImplementation(async (args: any) =>
      args.where.id === "user-1" ? { id: "user-1", phone: "+15550001111", password: "hash" } : null
    );
    await expect(caller().addPhone({ phone: "+15559998888" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(phoneOtpCreate).not.toHaveBeenCalled();
  });

  it("replacing a DIFFERENT phone refuses with a WRONG currentPassword", async () => {
    const realHash = await bcrypt.hash("real-password", 4);
    userFindUnique.mockImplementation(async (args: any) =>
      args.where.id === "user-1" ? { id: "user-1", phone: "+15550001111", password: realHash } : null
    );
    await expect(
      caller().addPhone({ phone: "+15559998888", currentPassword: "wrong-password" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(phoneOtpCreate).not.toHaveBeenCalled();
  });

  it("replacing a DIFFERENT phone succeeds with the CORRECT currentPassword", async () => {
    const realHash = await bcrypt.hash("real-password", 4);
    userFindUnique.mockImplementation(async (args: any) =>
      args.where.id === "user-1" ? { id: "user-1", phone: "+15550001111", password: realHash } : null
    );
    await expect(
      caller().addPhone({ phone: "+15559998888", currentPassword: "real-password" })
    ).resolves.toEqual({ success: true });
    expect(phoneOtpCreate).toHaveBeenCalledTimes(1);
  });

  it("an OAuth-only account (no password) is pointed at removePhone instead of being asked for a password it doesn't have", async () => {
    userFindUnique.mockImplementation(async (args: any) =>
      args.where.id === "user-1" ? { id: "user-1", phone: "+15550001111", password: null } : null
    );
    await expect(caller().addPhone({ phone: "+15559998888" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(phoneOtpCreate).not.toHaveBeenCalled();
  });
});
