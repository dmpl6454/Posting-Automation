/**
 * Phone OTP codes are bound to WHO requested them and WHY (security review
 * 2026-10-01).
 *
 * Before: verifyPhone accepted any {phone, otp} and wrote that phone onto the
 * CALLER's account. A hijacked session in account A could therefore redeem a
 * code that the attacker's own account B requested via addPhone(P_att) —
 * attaching P_att to A without ever passing addPhone's step-up check. Login
 * codes (sendPhoneOtp) and Settings codes (addPhone) were also
 * interchangeable.
 *
 * After: addPhone writes { userId: caller, purpose: "add-phone" };
 * verifyPhone/removePhone only redeem a row carrying exactly that.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("../lib/sms", () => ({ sendSms: vi.fn(async (..._a: any[]) => {}) }));
vi.mock("../lib/email", () => ({ sendEmail: vi.fn(async (..._a: any[]) => {}) }));
vi.mock("../lib/audit", () => ({
  createAuditLog: vi.fn(async () => {}),
  AUDIT_ACTIONS: { USER_PHONE_ADDED: "x", USER_PHONE_REMOVED: "y" },
}));
// The per-user addPhone limiter is covered by add-phone-rate-limit.test.ts.
vi.mock("../middleware/rate-limit.middleware", () => ({
  createRateLimitMiddleware: () => ({ next }: { next: () => Promise<any> }) => next(),
}));

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
let seq = 0;

// Emulates Prisma's where semantics for the keys these procedures use. A key
// that is ABSENT from `where` is no filter, exactly like the real client.
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
  deleteMany: vi.fn(async (args: any) => {
    const before = rows.length;
    rows = rows.filter((r) => !matches(r, args.where));
    return { count: before - rows.length };
  }),
  create: vi.fn(async (args: any) => {
    const row: Row = {
      id: `otp-${++seq}`,
      attempts: 0,
      used: false,
      createdAt: new Date(Date.now() + seq),
      userId: null,
      purpose: null,
      ...args.data,
    };
    rows.push(row);
    return row;
  }),
};

const currentPhone: Record<string, string | null> = {};
const userFindUnique = vi.fn(async (args: any) => {
  if (args.where.id) return { id: args.where.id, phone: currentPhone[args.where.id] ?? null, password: null };
  if (args.where.phone) {
    const owner = Object.entries(currentPhone).find(([, p]) => p === args.where.phone);
    return owner ? { id: owner[0] } : null;
  }
  return null;
});
const userUpdate = vi.fn(async (..._a: any[]) => ({}));

import { createCallerFactory } from "../trpc";
import { userRouter } from "../routers/user.router";

const callerAs = (userId: string) =>
  createCallerFactory(userRouter)({
    prisma: { phoneOtp, user: { findUnique: userFindUnique, update: userUpdate } } as any,
    organizationId: "org-1",
    session: { user: { id: userId, email: `${userId}@example.com`, isSuperAdmin: false }, expires: "2099-01-01" } as any,
  });

async function seedRow(partial: Partial<Row> & { phone: string; code: string }) {
  const { code, ...rest } = partial;
  rows.push({
    id: `otp-${++seq}`,
    otp: await bcrypt.hash(code, 4),
    attempts: 0,
    used: false,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(Date.now() + seq),
    userId: null,
    purpose: null,
    ...rest,
  });
}

const P_ATT = "+15550007777";
const P_OWN = "+15550001234";

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  for (const k of Object.keys(currentPhone)) delete currentPhone[k];
});

describe("user.verifyPhone only redeems a code issued to the caller for add-phone", () => {
  it("refuses a code that a DIFFERENT user requested (the hijacked-session bypass of addPhone's step-up)", async () => {
    await seedRow({ phone: P_ATT, code: "482913", userId: "user-B", purpose: "add-phone" });

    await expect(callerAs("user-A").verifyPhone({ phone: P_ATT, otp: "482913" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(userUpdate).not.toHaveBeenCalled();
    // And user-B's own row is untouched — no attempt was burned against it.
    expect(rows[0]!.attempts).toBe(0);
    expect(rows[0]!.used).toBe(false);
  });

  it("refuses a LOGIN code, even for the same user and phone", async () => {
    await seedRow({ phone: P_OWN, code: "482913", userId: "user-A", purpose: "login" });

    await expect(callerAs("user-A").verifyPhone({ phone: P_OWN, otp: "482913" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses an unbound legacy row (issued before codes carried an owner)", async () => {
    await seedRow({ phone: P_OWN, code: "482913" });

    await expect(callerAs("user-A").verifyPhone({ phone: P_OWN, otp: "482913" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("accepts the caller's own add-phone code", async () => {
    await seedRow({ phone: P_OWN, code: "482913", userId: "user-A", purpose: "add-phone" });

    await expect(callerAs("user-A").verifyPhone({ phone: P_OWN, otp: "482913" })).resolves.toMatchObject({
      success: true,
    });
    expect(userUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("user.removePhone only redeems a code issued to the caller for add-phone", () => {
  it("refuses another user's code and a login code", async () => {
    currentPhone["user-A"] = P_OWN;
    await seedRow({ phone: P_OWN, code: "111111", userId: "user-B", purpose: "add-phone" });
    await seedRow({ phone: P_OWN, code: "222222", userId: "user-A", purpose: "login" });

    await expect(callerAs("user-A").removePhone({ otp: "111111" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(callerAs("user-A").removePhone({ otp: "222222" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("accepts the caller's own add-phone code (the Settings 'Remove Number' flow sends it via addPhone)", async () => {
    currentPhone["user-A"] = P_OWN;
    await callerAs("user-A").addPhone({ phone: P_OWN });
    const issued = rows.find((r) => r.phone === P_OWN)!;
    // Swap in a known code — the real one only ever went out by SMS.
    issued.otp = await bcrypt.hash("333333", 4);

    await expect(callerAs("user-A").removePhone({ otp: "333333" })).resolves.toEqual({ success: true });
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-A" }, data: { phone: null, phoneVerified: null } })
    );
  });
});

describe("user.addPhone issues a bound code", () => {
  it("writes the caller's id and the add-phone purpose", async () => {
    await callerAs("user-A").addPhone({ phone: "+15550004321" });
    expect(phoneOtp.create).toHaveBeenCalledTimes(1);
    expect(phoneOtp.create.mock.calls[0]![0].data).toMatchObject({
      phone: "+15550004321",
      userId: "user-A",
      purpose: "add-phone",
    });
  });

  it("does not wipe a DIFFERENT user's pending code for the same number", async () => {
    await seedRow({ phone: "+15550005555", code: "482913", userId: "user-B", purpose: "add-phone" });
    await callerAs("user-A").addPhone({ phone: "+15550005555" });
    expect(rows.filter((r) => r.userId === "user-B")).toHaveLength(1);
  });
});
