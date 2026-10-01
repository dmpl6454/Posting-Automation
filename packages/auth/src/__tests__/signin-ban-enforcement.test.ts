/**
 * jwt() returns null for a banned/soft-deleted user, which kills the session —
 * but on a Google sign-in that just bounced the user back to /login with no
 * explanation (Auth.js clears cookies and redirects to the callbackUrl). A
 * signIn callback that returns false instead yields
 * /auth/error?error=AccessDenied, which tells them why.
 *
 * Auth.js passes signIn either the adapter row (getUserByAccount hit — a real
 * DB id) or, on a first Google link to an existing account, the provider
 * profile — whose `id` is a fresh crypto.randomUUID() that matches no row, so
 * the email fallback must run when the id finds nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const userFindUnique = vi.fn(async (..._a: any[]): Promise<any> => null);
const userFindFirst = vi.fn(async (..._a: any[]): Promise<any> => null);

vi.mock("@postautomation/db", () => ({
  prisma: {
    user: {
      findUnique: (a: any) => userFindUnique(a),
      findFirst: (a: any) => userFindFirst(a),
    },
    organizationMember: { findFirst: vi.fn() },
    account: {},
    session: {},
    verificationToken: {},
  },
  ensurePersonalOrg: vi.fn(),
  verifyAndConsumePhoneOtp: vi.fn(),
}));

import { authConfig } from "../config";

const signIn = () => authConfig.callbacks!.signIn! as (args: any) => Promise<boolean | string>;
const GOOGLE = { provider: "google", type: "oidc", providerAccountId: "g-1" };

beforeEach(() => {
  vi.clearAllMocks();
  userFindUnique.mockResolvedValue(null);
  userFindFirst.mockResolvedValue(null);
});

describe("signIn() — banned/deleted accounts are refused with AccessDenied", () => {
  it("refuses a banned adapter row (looked up by id)", async () => {
    userFindUnique.mockResolvedValue({ isBanned: true, deletedAt: null });
    const ok = await signIn()({ user: { id: "user-1", email: "a@x.com" }, account: GOOGLE });
    expect(ok).toBe(false);
    expect(userFindUnique.mock.calls[0]![0]).toMatchObject({
      where: { id: "user-1" },
      select: { isBanned: true, deletedAt: true },
    });
  });

  it("refuses a soft-deleted adapter row", async () => {
    userFindUnique.mockResolvedValue({ isBanned: false, deletedAt: new Date("2026-09-01") });
    const ok = await signIn()({ user: { id: "user-1", email: "a@x.com" }, account: GOOGLE });
    expect(ok).toBe(false);
  });

  it("allows a healthy adapter row without an email lookup", async () => {
    userFindUnique.mockResolvedValue({ isBanned: false, deletedAt: null });
    const ok = await signIn()({ user: { id: "user-1", email: "a@x.com" }, account: GOOGLE });
    expect(ok).toBe(true);
    expect(userFindFirst).not.toHaveBeenCalled();
  });

  it("falls back to a case-insensitive email lookup when the id matches no row (provider profile)", async () => {
    userFindFirst.mockResolvedValue({ isBanned: true, deletedAt: null });
    const ok = await signIn()({
      user: { id: "3f1c-random-uuid", email: "Banned@X.com" },
      account: GOOGLE,
    });
    expect(ok).toBe(false);
    expect(userFindFirst.mock.calls[0]![0]).toMatchObject({
      where: { email: { equals: "Banned@X.com", mode: "insensitive" } },
      select: { isBanned: true, deletedAt: true },
    });
  });

  it("refuses a provider profile whose email belongs to a soft-deleted row", async () => {
    userFindFirst.mockResolvedValue({ isBanned: false, deletedAt: new Date("2026-09-01") });
    const ok = await signIn()({ user: { id: "rand", email: "gone@x.com" }, account: GOOGLE });
    expect(ok).toBe(false);
  });

  it("looks up by email when the user carries no id", async () => {
    userFindFirst.mockResolvedValue({ isBanned: true, deletedAt: null });
    const ok = await signIn()({ user: { email: "b@x.com" }, account: GOOGLE });
    expect(ok).toBe(false);
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("allows a brand-new signup (no row by id or email)", async () => {
    const ok = await signIn()({ user: { id: "rand", email: "new@x.com" }, account: GOOGLE });
    expect(ok).toBe(true);
  });

  it("allows a healthy credentials login (authorize already returned the DB row)", async () => {
    userFindUnique.mockResolvedValue({ isBanned: false, deletedAt: null });
    const ok = await signIn()({
      user: { id: "user-1", email: "a@x.com" },
      account: { provider: "credentials", type: "credentials" },
    });
    expect(ok).toBe(true);
  });
});
