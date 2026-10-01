/**
 * Phone-otp sign-in only redeems a LOGIN code issued to that phone's current
 * owner (security review 2026-10-01). Settings codes (addPhone, purpose
 * "add-phone") and login codes used to be interchangeable because the check
 * keyed on the phone number alone.
 *
 * Uses the REAL verifyAndConsumePhoneOtp against an in-memory PhoneOtp table,
 * so the scope it applies is what is actually exercised.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

type Row = {
  id: string;
  phone: string;
  otp: string;
  attempts: number;
  used: boolean;
  expiresAt: Date;
  createdAt: Date;
  userId: string | null;
  purpose: string | null;
};
let rows: Row[] = [];

function matches(row: Row, where: any): boolean {
  for (const key of ["id", "phone", "userId", "purpose", "used"] as const) {
    if (key in where && (row as any)[key] !== where[key]) return false;
  }
  if (where.expiresAt?.gt && !(row.expiresAt > where.expiresAt.gt)) return false;
  if (where.attempts?.lt !== undefined && !(row.attempts < where.attempts.lt)) return false;
  return true;
}

const phoneOtp = {
  findFirst: vi.fn(async (args: any) => {
    const found = rows.filter((r) => matches(r, args.where)).sort((a, b) => +b.createdAt - +a.createdAt)[0];
    return found ? { ...found } : null;
  }),
  updateMany: vi.fn(async (args: any) => {
    const hit = rows.filter((r) => matches(r, args.where));
    for (const r of hit) {
      if (args.data.attempts?.increment) r.attempts += args.data.attempts.increment;
      if (args.data.used) r.used = true;
    }
    return { count: hit.length };
  }),
};

const PHONE = "+15551234567";
const userFindUnique = vi.fn(async (args: any) =>
  args.where.phone === PHONE
    ? {
        id: "owner-1",
        email: "owner@example.com",
        name: "Owner",
        image: null,
        isSuperAdmin: false,
        isBanned: false,
        deletedAt: null,
        phoneVerified: new Date(),
      }
    : null
);

vi.mock("@postautomation/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@postautomation/db")>();
  return {
    prisma: {
      user: { findUnique: (a: any) => userFindUnique(a) },
      // Deferred: the factory runs before this module's consts initialise.
      phoneOtp: {
        findFirst: (a: any) => phoneOtp.findFirst(a),
        updateMany: (a: any) => phoneOtp.updateMany(a),
      },
      account: {},
      session: {},
      verificationToken: {},
    },
    ensurePersonalOrg: vi.fn(),
    verifyAndConsumePhoneOtp: actual.verifyAndConsumePhoneOtp,
    PHONE_OTP_PURPOSE: actual.PHONE_OTP_PURPOSE,
  };
});

import { authConfig } from "../config";

const credentialsProvider = authConfig.providers.find((p: any) => p.id === "credentials") as any;
const authorize = credentialsProvider.options.authorize;

async function seed(partial: Partial<Row> & { code: string }) {
  const { code, ...rest } = partial;
  rows.push({
    id: `otp-${rows.length + 1}`,
    phone: PHONE,
    otp: await bcrypt.hash(code, 4),
    attempts: 0,
    used: false,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(Date.now() + rows.length),
    userId: null,
    purpose: null,
    ...rest,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
});

describe("Credentials phone-otp authorize() requires a login code issued to the phone's owner", () => {
  it("refuses an add-phone (Settings) code, even with the right digits", async () => {
    await seed({ code: "482913", userId: "owner-1", purpose: "add-phone" });
    expect(await authorize({ loginType: "phone-otp", phone: PHONE, otp: "482913" })).toBeNull();
    expect(rows[0]!.used).toBe(false);
  });

  it("refuses a login code bound to a different account", async () => {
    await seed({ code: "482913", userId: "someone-else", purpose: "login" });
    expect(await authorize({ loginType: "phone-otp", phone: PHONE, otp: "482913" })).toBeNull();
  });

  it("refuses an unbound legacy row", async () => {
    await seed({ code: "482913" });
    expect(await authorize({ loginType: "phone-otp", phone: PHONE, otp: "482913" })).toBeNull();
  });

  it("signs in with the owner's login code", async () => {
    await seed({ code: "482913", userId: "owner-1", purpose: "login" });
    const result = await authorize({ loginType: "phone-otp", phone: PHONE, otp: "482913" });
    expect(result).not.toBeNull();
    expect((result as any).id).toBe("owner-1");
    expect(rows[0]!.used).toBe(true);
  });
});
