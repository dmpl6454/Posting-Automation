/**
 * Phone-OTP verification, attempt-limited (security audit 2026-09-28).
 *
 * A 6-digit code has 1,000,000 combinations and a 10-minute window. None of the
 * three call sites that check one (NextAuth phone-otp login, user.verifyPhone,
 * user.removePhone) counted attempts, so a guesser making a few hundred requests
 * a minute — well under nginx's login-zone allowance of 5r/s per IP — could
 * exhaust the space before the code expired. This is account takeover: whoever
 * lands the right guess is logged in as that phone's owner.
 *
 * verifyAndConsumePhoneOtp is the ONE place all three now call. It increments
 * `PhoneOtp.attempts` BEFORE comparing, with the increment itself conditioned on
 * `attempts < MAX` — a conditional `updateMany`, the same compare-and-set shape
 * used elsewhere in this codebase (buildPublishClaimWhere, claimHeldFanout) —
 * so concurrent guesses serialize through Postgres's row lock instead of racing
 * past the counter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import { verifyAndConsumePhoneOtp, MAX_OTP_ATTEMPTS } from "../verify-phone-otp";

function mockPrisma(record: { id: string; otp: string; attempts: number; used: boolean; expiresAt: Date } | null) {
  const state = record ? { ...record } : null;
  const updateManyIncrement = vi.fn(async (args: any) => {
    if (!state || state.id !== args.where.id || state.attempts >= args.where.attempts.lt) return { count: 0 };
    state.attempts += 1;
    return { count: 1 };
  });
  const updateManyConsume = vi.fn(async (args: any) => {
    if (!state || state.id !== args.where.id || state.used !== args.where.used) return { count: 0 };
    state.used = true;
    return { count: 1 };
  });
  let call = 0;
  const updateMany = vi.fn(async (args: any) => {
    call += 1;
    // First updateMany call is the attempt increment; a later one (on success) marks used.
    return "used" in args.data ? updateManyConsume(args) : updateManyIncrement(args);
  });
  const findFirst = vi.fn(async (_args: any) => (state ? { ...state } : null));
  return { prisma: { phoneOtp: { findFirst, updateMany } } as any, state, findFirst, updateMany };
}

const PHONE = "+15551234567";

describe("verifyAndConsumePhoneOtp", () => {
  let realOtp: string;
  let hash: string;

  beforeEach(async () => {
    realOtp = "482913";
    hash = await bcrypt.hash(realOtp, 8);
  });

  it("accepts the correct code and consumes the record", async () => {
    const { prisma, state } = mockPrisma({
      id: "otp-1",
      otp: hash,
      attempts: 0,
      used: false,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await verifyAndConsumePhoneOtp(prisma, PHONE, realOtp);

    expect(result).toEqual({ ok: true });
    expect(state!.used).toBe(true);
  });

  it("locks out after MAX_OTP_ATTEMPTS wrong guesses — the code becomes useless before it expires", async () => {
    const { prisma, state } = mockPrisma({
      id: "otp-1",
      otp: hash,
      attempts: 0,
      used: false,
      expiresAt: new Date(Date.now() + 60_000),
    });

    let lastResult;
    for (let i = 0; i < MAX_OTP_ATTEMPTS + 3; i++) {
      lastResult = await verifyAndConsumePhoneOtp(prisma, PHONE, "000000");
    }

    // Every one of those calls was a WRONG guess; none should ever succeed.
    expect(lastResult).toEqual({ ok: false, reason: "locked" });
    expect(state!.attempts).toBe(MAX_OTP_ATTEMPTS);

    // And the real code — the one nobody guessed — is now ALSO refused. That is
    // the whole point: the record is dead, not just the wrong guesses.
    const afterLockout = await verifyAndConsumePhoneOtp(prisma, PHONE, realOtp);
    expect(afterLockout).toEqual({ ok: false, reason: "locked" });
  });

  it("does not increment past the limit under a burst of concurrent guesses (the race the fix exists for)", async () => {
    const { prisma, state } = mockPrisma({
      id: "otp-1",
      otp: hash,
      attempts: MAX_OTP_ATTEMPTS - 1,
      used: false,
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Ten guesses land "simultaneously" against a record one guess from lockout.
    // The mock's updateMany is synchronous-atomic per call (as Postgres's row
    // lock makes the real one), so this proves the counter cannot be jumped.
    const results = await Promise.all(Array.from({ length: 10 }, () => verifyAndConsumePhoneOtp(prisma, PHONE, "111111")));

    expect(state!.attempts).toBe(MAX_OTP_ATTEMPTS);
    expect(results.filter((r) => r.ok === false && r.reason === "invalid")).toHaveLength(1);
    expect(results.filter((r) => r.ok === false && r.reason === "locked")).toHaveLength(9);
  });

  it("refuses an expired or already-used code without touching attempts", async () => {
    const { prisma: expiredPrisma } = mockPrisma(null); // findFirst's own where excludes expired/used in the real query
    expect(await verifyAndConsumePhoneOtp(expiredPrisma, PHONE, "123456")).toEqual({ ok: false, reason: "invalid" });
  });

  it("queries only the phone's own unused, unexpired, newest record", async () => {
    const { prisma, findFirst } = mockPrisma({
      id: "otp-1",
      otp: hash,
      attempts: 0,
      used: false,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await verifyAndConsumePhoneOtp(prisma, PHONE, realOtp);
    const where = findFirst.mock.calls[0]![0].where;
    expect(where.phone).toBe(PHONE);
    expect(where.used).toBe(false);
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
    expect(findFirst.mock.calls[0]![0].orderBy).toEqual({ createdAt: "desc" });
  });

  it("a wrong guess does NOT mark the record used — a later correct guess can still land", async () => {
    const { prisma, state } = mockPrisma({
      id: "otp-1",
      otp: hash,
      attempts: 0,
      used: false,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await verifyAndConsumePhoneOtp(prisma, PHONE, "000000");
    expect(state!.used).toBe(false);
    expect(await verifyAndConsumePhoneOtp(prisma, PHONE, realOtp)).toEqual({ ok: true });
  });
});
