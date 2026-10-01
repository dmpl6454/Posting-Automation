/**
 * Bans/soft-deletes only killed a session at LOGIN time (the Credentials
 * authorize() checks) or, for tRPC only, via protectedProcedure's explicit
 * isBanned check — the jwt() callback's per-request DB re-check only ever
 * copied isBanned onto the token's VALUE, it never acted on it. So:
 *
 *   - Google sign-in has no signIn callback at all, so a banned/deleted
 *     user's existing Google account could complete OAuth and get a session.
 *   - Every non-tRPC route under apps/web/app/api/** that reads a session via
 *     auth() directly (upload, the OAuth channel-connect callback, the chat
 *     stream, ...) checked only "is there a session", never isBanned/
 *     deletedAt, so an already-authenticated banned/deleted user of EITHER
 *     provider could keep using all of them.
 *   - deletedAt was entirely absent from the re-check select, so an
 *     admin-deleted user's already-issued session was never revoked
 *     anywhere, by any path — the delete only blocked a brand NEW
 *     Credentials login.
 *
 * (security audit 2026-09-28, confirmed by dedicated investigation)
 *
 * Fix: jwt() now returns null (NextAuth's own "invalid session" signal, the
 * same mechanism the pre-existing passwordChangedAt check already uses to
 * force a live re-login) the moment a per-request DB re-check finds
 * isBanned or deletedAt set — for BOTH providers (this callback already runs
 * on first sign-in either way), killing the session for every consumer of
 * auth() in one place, not just tRPC.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const userFindUnique = vi.fn();
const memberFindFirst = vi.fn();

vi.mock("@postautomation/db", () => ({
  prisma: {
    user: { findUnique: (a: any) => userFindUnique(a) },
    organizationMember: { findFirst: (a: any) => memberFindFirst(a) },
    account: {},
    session: {},
    verificationToken: {},
  },
  ensurePersonalOrg: vi.fn(),
  verifyAndConsumePhoneOtp: vi.fn(),
}));

import { authConfig } from "../config";

const jwtCallback = authConfig.callbacks!.jwt! as (args: any) => Promise<any>;

beforeEach(() => {
  vi.clearAllMocks();
  memberFindFirst.mockResolvedValue(null);
});

describe("jwt() callback — bans/soft-deletes kill the session everywhere, not just tRPC", () => {
  it("returns null (session killed) once a DB re-check finds isBanned true, even mid-lifetime", async () => {
    userFindUnique.mockResolvedValue({
      isBanned: true,
      isSuperAdmin: false,
      passwordChangedAt: null,
      appRole: "USER",
      deletedAt: null,
    });
    const token = { id: "user-1", iat: Math.floor(Date.now() / 1000) };
    const result = await jwtCallback({ token });
    expect(result).toBeNull();
  });

  it("returns null once a DB re-check finds deletedAt set", async () => {
    userFindUnique.mockResolvedValue({
      isBanned: false,
      isSuperAdmin: false,
      passwordChangedAt: null,
      appRole: "USER",
      deletedAt: new Date("2026-09-01"),
    });
    const token = { id: "user-1", iat: Math.floor(Date.now() / 1000) };
    const result = await jwtCallback({ token });
    expect(result).toBeNull();
  });

  it("kills the session on the VERY FIRST callback invocation at sign-in (both providers share this one function)", async () => {
    // NextAuth passes `user` only on the initial sign-in call; token.id is
    // set from it in the SAME pass, and the re-check below runs unconditionally.
    userFindUnique.mockResolvedValue({
      isBanned: true,
      isSuperAdmin: false,
      passwordChangedAt: null,
      appRole: "USER",
      deletedAt: null,
    });
    const token: Record<string, unknown> = {};
    const user = { id: "user-1", isSuperAdmin: false, isBanned: false, appRole: "USER" };
    const result = await jwtCallback({ token, user });
    expect(result).toBeNull();
  });

  it("a healthy, non-banned, non-deleted user keeps a normal token", async () => {
    userFindUnique.mockResolvedValue({
      isBanned: false,
      isSuperAdmin: false,
      passwordChangedAt: null,
      appRole: "USER",
      deletedAt: null,
    });
    const token = { id: "user-1", iat: Math.floor(Date.now() / 1000) };
    const result = await jwtCallback({ token });
    expect(result).not.toBeNull();
    expect(result.isBanned).toBe(false);
  });

  it("the DB re-check now selects deletedAt (previously absent from the select entirely)", async () => {
    userFindUnique.mockResolvedValue({
      isBanned: false,
      isSuperAdmin: false,
      passwordChangedAt: null,
      appRole: "USER",
      deletedAt: null,
    });
    const token = { id: "user-1", iat: Math.floor(Date.now() / 1000) };
    await jwtCallback({ token });
    const select = userFindUnique.mock.calls[0]![0].select;
    expect(select.deletedAt).toBe(true);
  });

  it("the pre-existing passwordChangedAt kill-switch is unaffected", async () => {
    const now = Math.floor(Date.now() / 1000);
    userFindUnique.mockResolvedValue({
      isBanned: false,
      isSuperAdmin: false,
      passwordChangedAt: new Date((now + 60) * 1000), // changed AFTER token was issued
      appRole: "USER",
      deletedAt: null,
    });
    const token = { id: "user-1", iat: now };
    const result = await jwtCallback({ token });
    expect(result).toBeNull();
  });
});
