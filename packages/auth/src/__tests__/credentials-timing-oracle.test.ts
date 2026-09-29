/**
 * Credentials authorize()'s "no such user" branch returned `null`
 * IMMEDIATELY, before ever touching bcrypt — while a real, existing
 * credentials account with a WRONG password still ran a full bcrypt-12
 * compare (tens–low hundreds of ms) before returning the identical `null`.
 * Both cases produce the same CredentialsSignin error code (correct — no
 * enumeration via the error itself), but they are distinguishable by wall-
 * clock response time: a genuine account-existence oracle the code-level
 * protections don't address (security audit 2026-09-28, confirmed by
 * dedicated investigation).
 *
 * Fix: the no-such-user / no-password branch now always performs a dummy
 * bcrypt.compare against a fixed hash before returning null, so a bcrypt
 * comparison runs on EVERY login attempt regardless of whether the account
 * exists. This test asserts the behavioral contract (bcrypt.compare is
 * invoked in both cases) rather than measuring wall-clock time, which would
 * be flaky in a unit test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const bcryptCompare = vi.fn(async (..._a: any[]) => false);
vi.mock("bcryptjs", () => ({
  default: { compare: (...a: any[]) => bcryptCompare(...a), hash: vi.fn(async () => "hash") },
}));

const userFindFirst = vi.fn();
vi.mock("@postautomation/db", () => ({
  prisma: {
    user: { findFirst: (a: any) => userFindFirst(a) },
    account: {},
    session: {},
    verificationToken: {},
  },
  ensurePersonalOrg: vi.fn(),
  verifyAndConsumePhoneOtp: vi.fn(),
}));

import { authConfig } from "../config";

const credentialsProvider = authConfig.providers.find((p: any) => p.id === "credentials") as any;
const authorize = credentialsProvider.options.authorize;

beforeEach(() => vi.clearAllMocks());

describe("Credentials authorize() — no bcrypt timing oracle for account existence", () => {
  it("runs a dummy bcrypt.compare when no user exists for the email", async () => {
    userFindFirst.mockResolvedValue(null);
    const result = await authorize({ email: "nobody@example.com", password: "whatever123" });
    expect(result).toBeNull();
    expect(bcryptCompare).toHaveBeenCalledTimes(1);
    expect(bcryptCompare.mock.calls[0]![0]).toBe("whatever123");
  });

  it("still runs a real bcrypt.compare for an existing credentials account with the wrong password", async () => {
    userFindFirst.mockResolvedValue({
      id: "user-1",
      email: "real@example.com",
      name: "Real",
      image: null,
      password: "real-hash",
      isSuperAdmin: false,
      isBanned: false,
      deletedAt: null,
      accounts: [],
    });
    bcryptCompare.mockResolvedValueOnce(false);
    const result = await authorize({ email: "real@example.com", password: "wrong-password" });
    expect(result).toBeNull();
    expect(bcryptCompare).toHaveBeenCalledTimes(1);
    expect(bcryptCompare.mock.calls[0]![1]).toBe("real-hash");
  });

  it("still authenticates on a correct password", async () => {
    userFindFirst.mockResolvedValue({
      id: "user-1",
      email: "real@example.com",
      name: "Real",
      image: null,
      password: "real-hash",
      isSuperAdmin: false,
      isBanned: false,
      deletedAt: null,
      accounts: [],
    });
    bcryptCompare.mockResolvedValueOnce(true);
    const result = await authorize({ email: "real@example.com", password: "correct" });
    expect((result as any).id).toBe("user-1");
  });
});
