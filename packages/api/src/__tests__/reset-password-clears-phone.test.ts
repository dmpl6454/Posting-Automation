/**
 * resetPassword did not touch phone/phoneVerified — the other half of the
 * phone-replace-step-up gap (security audit 2026-09-28, confirmed by
 * dedicated investigation).
 *
 * Traced attack: attacker hijacks a live session, attaches their own phone
 * number as a new login method (now separately gated — see
 * phone-replace-step-up.test.ts), and the victim later resets their password
 * believing that fully evicts the attacker. It didn't: resetPassword only
 * invalidated the password itself (passwordChangedAt vs a JWT's iat) and
 * deleted DB sessions — the attacker's phone-otp login path survived
 * untouched and could still authenticate as the victim afterward.
 *
 * Fix: resetPassword now also clears phone/phoneVerified, so any phone
 * attached before the reset — attacker's or the legitimate owner's own —
 * requires re-verification afterward, exactly like the password itself does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const passwordResetTokenFindUnique = vi.fn();
const passwordResetTokenDelete = vi.fn(async () => ({}));
const userUpdate = vi.fn(async (args: any) => ({ id: args.where.id, ...args.data }));
const sessionDeleteMany = vi.fn(async () => ({ count: 0 }));

vi.mock("../lib/email", () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock("../lib/sms", () => ({ sendSms: vi.fn(async () => {}) }));

import { createCallerFactory } from "../trpc";
import { authRouter } from "../routers/auth.router";

const caller = () =>
  createCallerFactory(authRouter)({
    prisma: {
      passwordResetToken: { findUnique: passwordResetTokenFindUnique, delete: passwordResetTokenDelete },
      user: { update: userUpdate },
      session: { deleteMany: sessionDeleteMany },
    } as any,
    session: null,
  });

beforeEach(() => {
  vi.clearAllMocks();
  passwordResetTokenFindUnique.mockResolvedValue({
    id: "tok-1",
    userId: "user-1",
    expiresAt: new Date(Date.now() + 60_000),
  });
});

describe("auth.resetPassword clears any attached phone login method", () => {
  it("clears phone and phoneVerified alongside the password", async () => {
    await caller().resetPassword({ token: "tok-1", password: "new-password-123" });

    expect(userUpdate).toHaveBeenCalledTimes(1);
    const data = userUpdate.mock.calls[0]![0].data;
    expect(data.phone).toBeNull();
    expect(data.phoneVerified).toBeNull();
    // Existing behavior unchanged.
    expect(data.password).toBeTruthy();
    expect(data.passwordChangedAt).toBeInstanceOf(Date);
  });

  // The removal used to be silent — the success screen now says so, but only
  // when there was actually a phone to remove.
  it("reports phoneRemoved: true when the account had a phone", async () => {
    passwordResetTokenFindUnique.mockResolvedValueOnce({
      id: "tok-1",
      userId: "user-1",
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: "user-1", phone: "+15551234567" },
    });
    await expect(caller().resetPassword({ token: "tok-1", password: "new-password-123" })).resolves.toEqual({
      success: true,
      phoneRemoved: true,
    });
  });

  it("reports phoneRemoved: false when there was no phone", async () => {
    passwordResetTokenFindUnique.mockResolvedValueOnce({
      id: "tok-1",
      userId: "user-1",
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: "user-1", phone: null },
    });
    await expect(caller().resetPassword({ token: "tok-1", password: "new-password-123" })).resolves.toEqual({
      success: true,
      phoneRemoved: false,
    });
  });
});
