/**
 * Super-admin Teams (2026-08-05).
 *
 * A "team" is an Organization with >1 member — Channel is already org-scoped,
 * so pooling needs no schema change. These tests lock the two things that could
 * cause real damage:
 *   1. The last-OWNER guard (an ownerless org is unrecoverable via this UI).
 *   2. OWNER is never assignable (a second OWNER org per user would break the
 *      pending partial unique index in
 *      migrations/20260603120000_one_owner_org_per_user/).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TEAM_ASSIGNABLE_ROLES,
  assertNotLastOwner,
  type MembershipLike,
} from "../lib/team-membership";

const owner = (userId: string): MembershipLike => ({ userId, role: "OWNER" });
const member = (userId: string): MembershipLike => ({ userId, role: "MEMBER" });

describe("TEAM_ASSIGNABLE_ROLES", () => {
  it("offers exactly MEMBER and ADMIN", () => {
    expect(TEAM_ASSIGNABLE_ROLES).toEqual(["MEMBER", "ADMIN"]);
  });

  it("never includes OWNER (pending one-OWNER-org-per-user unique index)", () => {
    expect(TEAM_ASSIGNABLE_ROLES).not.toContain("OWNER");
  });

  it("never includes the removed VIEWER role", () => {
    expect(TEAM_ASSIGNABLE_ROLES).not.toContain("VIEWER");
  });
});

describe("assertNotLastOwner", () => {
  it("throws when removing the only OWNER", () => {
    expect(() => assertNotLastOwner([owner("a"), member("b")], "a")).toThrow(
      /last owner/i
    );
  });

  it("allows removing a MEMBER while an OWNER remains", () => {
    expect(() => assertNotLastOwner([owner("a"), member("b")], "b")).not.toThrow();
  });

  it("allows removing one OWNER when another OWNER remains", () => {
    expect(() =>
      assertNotLastOwner([owner("a"), owner("b"), member("c")], "a")
    ).not.toThrow();
  });

  it("does not throw for a user who is not a member (caller handles NOT_FOUND)", () => {
    expect(() => assertNotLastOwner([owner("a")], "zz")).not.toThrow();
  });
});

// ── Wiring lock ──────────────────────────────────────────────────────────────
// Reads the router source and asserts every procedure is superAdminProcedure.
// A refactor that swaps one to orgProcedure/protectedProcedure would expose
// cross-org membership writes to ordinary users — this fails first.
/** Strip comments so prose mentioning a procedure name can't trip the lock. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const teamsSrc = stripComments(
  readFileSync(join(__dirname, "..", "routers", "admin", "teams.router.ts"), "utf8")
);

describe("admin.teams router wiring", () => {
  const PROCEDURES = [
    "list",
    "getById",
    "searchUsers",
    "addMember",
    "removeMember",
    "updateMemberRole",
  ];

  it("defines all six procedures", () => {
    for (const p of PROCEDURES) {
      expect(teamsSrc).toMatch(new RegExp(`\\b${p}:\\s*superAdminProcedure`));
    }
  });

  it("uses ONLY superAdminProcedure — no weaker procedure leaks in", () => {
    expect(teamsSrc).not.toMatch(/\borgProcedure\b/);
    expect(teamsSrc).not.toMatch(/\bprotectedProcedure\b/);
    expect(teamsSrc).not.toMatch(/\bpublicProcedure\b/);
    expect(teamsSrc).not.toMatch(/\badminOrgProcedure\b/);
  });

  it("never writes role OWNER", () => {
    expect(teamsSrc).not.toMatch(/role:\s*"OWNER"/);
  });

  it("guards mutations with assertNotLastOwner", () => {
    expect(teamsSrc).toMatch(/assertNotLastOwner/);
  });

  it("is registered on the admin router", () => {
    const indexSrc = readFileSync(
      join(__dirname, "..", "routers", "admin", "index.ts"),
      "utf8"
    );
    expect(indexSrc).toMatch(/teams:\s*adminTeamsRouter/);
  });
});
