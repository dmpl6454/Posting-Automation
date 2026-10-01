/**
 * The Credentials provider's phone-otp branch authenticated on the `phone`
 * column matching plus a valid OTP alone — it never checked phoneVerified,
 * unlike sendPhoneOtp (auth.router.ts), which already gates on it. `phone`
 * and `phoneVerified` are always written together by verifyPhone today, so
 * this never actually diverges in practice — but defense in depth has no
 * reason to depend on that invariant holding forever elsewhere in the
 * codebase (security audit 2026-09-28, minor finding from the dedicated
 * phone-login investigation).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const userFindUnique = vi.fn();
const verifyAndConsumePhoneOtp = vi.fn(async (..._a: any[]) => ({ ok: true }));

vi.mock("@postautomation/db", () => ({
  prisma: {
    user: { findUnique: (a: any) => userFindUnique(a) },
    account: {},
    session: {},
    verificationToken: {},
  },
  ensurePersonalOrg: vi.fn(),
  verifyAndConsumePhoneOtp: (...a: any[]) => verifyAndConsumePhoneOtp(...a),
  PHONE_OTP_PURPOSE: { LOGIN: "login", ADD_PHONE: "add-phone" },
}));

import { authConfig } from "../config";

const credentialsProvider = authConfig.providers.find((p: any) => p.id === "credentials") as any;
// NextAuth's provider factory normalizes `.authorize` on the top-level
// provider object to a stub (`() => null`); the function we actually passed
// into CredentialsProvider({...}) lives at `.options.authorize`.
const authorize = credentialsProvider.options.authorize;

beforeEach(() => vi.clearAllMocks());

describe("Credentials phone-otp authorize() requires phoneVerified", () => {
  it("refuses a user whose phoneVerified is not set, even with a valid OTP", async () => {
    userFindUnique.mockResolvedValue({
      id: "user-1",
      email: "a@b.c",
      name: "A",
      image: null,
      isSuperAdmin: false,
      isBanned: false,
      deletedAt: null,
      phoneVerified: null,
    });
    const result = await authorize({ loginType: "phone-otp", phone: "+15551234567", otp: "123456" });
    expect(result).toBeNull();
  });

  it("still authenticates a real, verified phone user", async () => {
    userFindUnique.mockResolvedValue({
      id: "user-1",
      email: "a@b.c",
      name: "A",
      image: null,
      isSuperAdmin: false,
      isBanned: false,
      deletedAt: null,
      phoneVerified: new Date(),
    });
    const result = await authorize({ loginType: "phone-otp", phone: "+15551234567", otp: "123456" });
    expect(result).not.toBeNull();
    expect((result as any).id).toBe("user-1");
    // Only a login code issued to this account (phone-otp-purpose-binding.test.ts).
    expect(verifyAndConsumePhoneOtp).toHaveBeenCalledWith(expect.anything(), "+15551234567", "123456", {
      userId: "user-1",
      purpose: "login",
    });
  });
});
