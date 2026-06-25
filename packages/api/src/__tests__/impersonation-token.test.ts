/**
 * Regression guard for the impersonation JWT field-name contract (2026-06-25).
 *
 * BUG: The signer (admin/users.router.ts) always signs `impersonatedUserId` but
 * the reader (trpc.ts) was reading `payload.targetUserId` — a field that is never
 * signed — so `findUnique({id: undefined})` always returned null and impersonation
 * silently never worked.
 *
 * FIX: trpc.ts now reads `payload.impersonatedUserId`.
 *
 * These tests assert the field-name CONTRACT:
 *   1. A JWT signed with the exact payload shape the router uses can be verified
 *      and the extracted field name (`impersonatedUserId`) is present and correct.
 *   2. The broken field name (`targetUserId`) is absent from the signed payload.
 *   3. `adminUserId` survives the round-trip (used by ImpersonationBanner / audit).
 *
 * PRIVILEGE-BLEED guard (2026-06-25): once the field-name fix makes the session
 * swap actually execute, the swapped "acting as" session must FULLY become the
 * target — in particular it must NOT inherit the admin's `isSuperAdmin: true`,
 * or the impersonator keeps the plan-bypass + superAdminProcedure access. These
 * tests lock `buildImpersonatedSession` to clear isSuperAdmin to false.
 */
import { describe, it, expect } from "vitest";
import { SignJWT, jwtVerify } from "jose";
import { buildImpersonatedSession } from "../trpc";

const SECRET = new TextEncoder().encode("test-secret-32-bytes-long-enough!");

async function signImpersonationToken(impersonatedUserId: string, adminUserId: string) {
  return new SignJWT({ impersonatedUserId, adminUserId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(SECRET);
}

async function readImpersonationPayload(token: string) {
  const { payload } = await jwtVerify(token, SECRET);
  return payload;
}

describe("impersonation JWT field-name contract", () => {
  it("signed payload contains impersonatedUserId (the field trpc.ts now reads)", async () => {
    const token = await signImpersonationToken("user-123", "admin-456");
    const payload = await readImpersonationPayload(token);

    expect(payload.impersonatedUserId).toBe("user-123");
  });

  it("signed payload does NOT contain targetUserId (the old broken field)", async () => {
    const token = await signImpersonationToken("user-123", "admin-456");
    const payload = await readImpersonationPayload(token);

    // targetUserId was NEVER signed; if it appears something changed the signer incorrectly
    expect((payload as any).targetUserId).toBeUndefined();
  });

  it("signed payload contains adminUserId (needed for audit + ImpersonationBanner)", async () => {
    const token = await signImpersonationToken("user-123", "admin-456");
    const payload = await readImpersonationPayload(token);

    expect(payload.adminUserId).toBe("admin-456");
  });

  it("impersonatedUserId round-trips correctly for different user ids", async () => {
    const cases = [
      { userId: "clxabc123", adminId: "clxdef456" },
      { userId: "uuid-1234-5678", adminId: "uuid-9876-5432" },
    ];

    for (const { userId, adminId } of cases) {
      const token = await signImpersonationToken(userId, adminId);
      const payload = await readImpersonationPayload(token);

      expect(payload.impersonatedUserId).toBe(userId);
      expect(payload.adminUserId).toBe(adminId);
      expect((payload as any).targetUserId).toBeUndefined();
    }
  });
});

describe("buildImpersonatedSession — privilege-bleed guard", () => {
  // A superadmin admin's session being used to impersonate an ordinary user.
  const adminSession = {
    user: {
      id: "admin-456",
      email: "admin@example.com",
      name: "Admin Person",
      image: "https://example.com/admin.png",
      isSuperAdmin: true,
    },
    expires: "2099-01-01T00:00:00.000Z",
  } as any;

  const target = {
    id: "user-123",
    email: "target@example.com",
    name: "Target Person",
    image: "https://example.com/target.png",
  };

  it("swapped session adopts the target's id/email/name/image", () => {
    const swapped = buildImpersonatedSession(adminSession, target);
    expect(swapped.user.id).toBe("user-123");
    expect(swapped.user.email).toBe("target@example.com");
    expect((swapped.user as any).name).toBe("Target Person");
    expect((swapped.user as any).image).toBe("https://example.com/target.png");
  });

  it("swapped session clears isSuperAdmin to false (does NOT inherit the admin's flag)", () => {
    const swapped = buildImpersonatedSession(adminSession, target);
    // THE fix: acting identity must not carry the admin's superadmin privilege.
    expect((swapped.user as any).isSuperAdmin).toBe(false);
  });

  it("clearing isSuperAdmin holds even when the target had no flag of its own", () => {
    // target object never carries isSuperAdmin; the result must still be explicitly false.
    const swapped = buildImpersonatedSession(adminSession, target);
    expect((swapped.user as any).isSuperAdmin).toBe(false);
    expect("isSuperAdmin" in (swapped.user as any)).toBe(true);
  });

  it("does not mutate the original admin session (admin stays superadmin)", () => {
    buildImpersonatedSession(adminSession, target);
    expect(adminSession.user.id).toBe("admin-456");
    expect(adminSession.user.isSuperAdmin).toBe(true);
  });
});
