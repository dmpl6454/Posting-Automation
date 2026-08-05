/**
 * Pure guards for super-admin team membership management.
 *
 * Kept free of Prisma/tRPC so the rules that matter are unit-testable without a
 * DB harness (same discipline as publish-stagger.ts / group-stats.ts).
 */
import { TRPCError } from "@trpc/server";

/**
 * Roles a super admin may assign when adding/updating a team member.
 *
 * OWNER is deliberately EXCLUDED. A pending partial unique index
 * (packages/db/prisma/migrations/20260603120000_one_owner_org_per_user/) enforces
 * one OWNER org per user and FAILS TO APPLY if any user owns two — so granting a
 * second OWNER here would create a new offender and block that remediation.
 * Ownership transfer stays in the org-scoped team router.
 */
export const TEAM_ASSIGNABLE_ROLES = ["MEMBER", "ADMIN"] as const;

export type TeamAssignableRole = (typeof TEAM_ASSIGNABLE_ROLES)[number];

/** Minimal shape needed by the guards — matches an OrganizationMember row. */
export type MembershipLike = { userId: string; role: string };

/**
 * Refuse an operation that would leave the org with no OWNER.
 *
 * An ownerless org cannot be repaired through this UI (OWNER is not assignable),
 * so this must be checked BEFORE any delete/update. A userId that is not a
 * member is a no-op here — the caller surfaces NOT_FOUND.
 */
export function assertNotLastOwner(
  members: MembershipLike[],
  targetUserId: string
): void {
  const target = members.find((m) => m.userId === targetUserId);
  if (!target || target.role !== "OWNER") return;

  const remainingOwners = members.filter(
    (m) => m.role === "OWNER" && m.userId !== targetUserId
  ).length;

  if (remainingOwners === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Cannot remove or demote the last owner of a workspace. Transfer ownership first.",
    });
  }
}
