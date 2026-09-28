import bcrypt from "bcryptjs";

/**
 * Attempt-limited phone-OTP verification — the ONE place every consumer checks
 * a code (security audit 2026-09-28).
 *
 * Before this, three call sites (NextAuth's phone-otp `authorize`,
 * `user.verifyPhone`, `user.removePhone`) each ran their own
 * `findFirst` + `bcrypt.compare` with no attempt counter. A 6-digit code has
 * 1,000,000 combinations and a 10-minute window; nothing stopped a guesser from
 * trying all of them before it expired. Landing the right guess signs in as
 * that phone's owner — this is account takeover, not a nuisance.
 *
 * The fix increments `attempts` BEFORE the bcrypt compare, and the increment
 * itself is conditioned on `attempts < MAX_OTP_ATTEMPTS` via a conditional
 * `updateMany` — a compare-and-set on one row, which Postgres serialises
 * through its row lock. Two concurrent guesses against the last remaining
 * attempt cannot both get through: only one `updateMany` call can see
 * `attempts < MAX` true and win the row lock first. This mirrors the pattern
 * already used for the publish claim (`buildPublishClaimWhere`) and the caption
 * fan-out hold (`claimHeldFanout`) elsewhere in this codebase.
 */

export const MAX_OTP_ATTEMPTS = 5;

type PhoneOtpPrismaClient = {
  phoneOtp: {
    findFirst: (args: any) => Promise<{ id: string; otp: string; attempts: number } | null>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
};

export type VerifyOtpResult = { ok: true } | { ok: false; reason: "invalid" | "locked" };

export async function verifyAndConsumePhoneOtp(
  prisma: PhoneOtpPrismaClient,
  phone: string,
  code: string
): Promise<VerifyOtpResult> {
  const record = await prisma.phoneOtp.findFirst({
    where: { phone, used: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!record) return { ok: false, reason: "invalid" };

  // Claim one attempt. `count === 0` means either the row is already at the
  // limit, or (a benign race) someone else's claim won first — either way this
  // guess does not get to run bcrypt.compare.
  const claimed = await prisma.phoneOtp.updateMany({
    where: { id: record.id, attempts: { lt: MAX_OTP_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return { ok: false, reason: "locked" };

  const isValid = await bcrypt.compare(code, record.otp);
  if (!isValid) return { ok: false, reason: "invalid" };

  // Consume it. The `used: false` guard closes the same race for the SUCCESS
  // path: two concurrent correct guesses (e.g. a double-submitted form) must
  // not both report success and run their callers' side effects twice.
  const consumed = await prisma.phoneOtp.updateMany({
    where: { id: record.id, used: false },
    data: { used: true },
  });
  if (consumed.count === 0) return { ok: false, reason: "invalid" };

  return { ok: true };
}
