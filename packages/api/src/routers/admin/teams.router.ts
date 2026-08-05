/**
 * Super-admin team management (2026-08-05).
 *
 * A "team" IS an Organization with more than one member. Channel is already
 * org-scoped (organizationId, no userId), so adding a membership row pools every
 * channel, insight and post automatically — no schema change, and orgProcedure
 * (the single gate preventing cross-org IDOR) is untouched.
 *
 * Every procedure is superAdminProcedure: these read and write membership across
 * ALL organizations.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, superAdminProcedure } from "../../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../../lib/audit";
import {
  TEAM_ASSIGNABLE_ROLES,
  assertNotLastOwner,
  type MembershipLike,
} from "../../lib/team-membership";

const assignableRole = z.enum(TEAM_ASSIGNABLE_ROLES);

/**
 * Load an org's memberships for the guards, or 404.
 *
 * `prisma` is typed `any` to match the sibling admin routers — narrowing it to a
 * structural shape fights Prisma's generic client types for no safety gain, since
 * the return value is validated as MembershipLike[] below.
 */
async function loadMembers(
  prisma: any,
  organizationId: string
): Promise<MembershipLike[]> {
  const org = (await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, members: { select: { userId: true, role: true } } },
  })) as { id: string; members: MembershipLike[] } | null;

  if (!org) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
  }
  return org.members;
}

export const adminTeamsRouter = createRouter({
  /**
   * Workspaces that are already teams (>1 member). `onlyTeams: false` lists every
   * workspace, so a super admin can turn a single-member workspace INTO a team.
   */
  list: superAdminProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(50),
        cursor: z.string().optional(),
        search: z.string().optional(),
        onlyTeams: z.boolean().default(true),
      })
    )
    .query(async ({ ctx, input }) => {
      const { limit, cursor, search, onlyTeams } = input;

      const where: Record<string, unknown> = {};
      if (search) {
        where.OR = [
          { name: { contains: search, mode: "insensitive" } },
          { slug: { contains: search, mode: "insensitive" } },
          {
            members: {
              some: { user: { email: { contains: search, mode: "insensitive" } } },
            },
          },
        ];
      }

      const items = await ctx.prisma.organization.findMany({
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        where,
        select: {
          id: true,
          name: true,
          slug: true,
          plan: true,
          createdAt: true,
          _count: { select: { members: true, channels: true, posts: true } },
        },
        orderBy: [{ createdAt: "desc" }],
      });

      let nextCursor: string | undefined;
      if (items.length > limit) {
        nextCursor = items.pop()!.id;
      }

      // Filter AFTER pagination: Prisma cannot filter on a relation _count.
      // nextCursor still walks every row, so no page is skipped.
      const filtered = onlyTeams
        ? items.filter((o) => o._count.members > 1)
        : items;

      return { items: filtered, nextCursor };
    }),

  /** One workspace: members with BOTH roles, plus channel counts by platform. */
  getById: superAdminProcedure
    .input(z.object({ organizationId: z.string() }))
    .query(async ({ ctx, input }) => {
      const org = await ctx.prisma.organization.findUnique({
        where: { id: input.organizationId },
        select: {
          id: true,
          name: true,
          slug: true,
          plan: true,
          createdAt: true,
          members: {
            select: {
              id: true,
              role: true,
              createdAt: true,
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  image: true,
                  appRole: true,
                  isSuperAdmin: true,
                },
              },
            },
            orderBy: [{ role: "asc" }, { createdAt: "asc" }],
          },
          _count: { select: { channels: true, posts: true } },
        },
      });
      if (!org) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
      }

      const grouped = await ctx.prisma.channel.groupBy({
        by: ["platform"],
        where: { organizationId: input.organizationId, isActive: true },
        _count: { _all: true },
      });

      return {
        ...org,
        channelsByPlatform: grouped
          .map((g) => ({ platform: g.platform, count: g._count._all }))
          .sort((a, b) => b.count - a.count),
      };
    }),

  /** Type-ahead for the add-member dialog. Excludes existing members. */
  searchUsers: superAdminProcedure
    .input(
      z.object({
        organizationId: z.string(),
        query: z.string().min(1).max(200),
        limit: z.number().min(1).max(25).default(10),
      })
    )
    .query(async ({ ctx, input }) => {
      const q = input.query.trim();
      if (!q) return [];

      return ctx.prisma.user.findMany({
        where: {
          isBanned: false,
          // NOTE: the User back-relation is `memberships` (NOT `members`, which is
          // Organization's side of the same relation).
          memberships: { none: { organizationId: input.organizationId } },
          OR: [
            { email: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
          ],
        },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          appRole: true,
          isSuperAdmin: true,
        },
        take: input.limit,
        orderBy: { createdAt: "desc" },
      });
    }),

  /**
   * Add a user to a workspace. Idempotent against
   * @@unique([userId, organizationId]) so a double-click cannot 500.
   */
  addMember: superAdminProcedure
    .input(
      z.object({
        organizationId: z.string(),
        userId: z.string(),
        role: assignableRole.default("MEMBER"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await loadMembers(ctx.prisma, input.organizationId);

      const user = await ctx.prisma.user.findUnique({
        where: { id: input.userId },
        select: { id: true, email: true },
      });
      if (!user) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      }

      const existing = await ctx.prisma.organizationMember.findUnique({
        where: {
          userId_organizationId: {
            userId: input.userId,
            organizationId: input.organizationId,
          },
        },
      });
      if (existing) return { membership: existing, alreadyMember: true };

      const membership = await ctx.prisma.organizationMember.create({
        data: {
          userId: input.userId,
          organizationId: input.organizationId,
          role: input.role,
        },
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        organizationId: input.organizationId,
        action: AUDIT_ACTIONS.ADMIN_TEAM_MEMBER_ADDED,
        entityType: "OrganizationMember",
        entityId: membership.id,
        metadata: { addedUserId: input.userId, email: user.email, role: input.role },
      }).catch(() => {});

      return { membership, alreadyMember: false };
    }),

  /** Remove a member. Non-destructive: only the membership row is deleted. */
  removeMember: superAdminProcedure
    .input(z.object({ organizationId: z.string(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const members = await loadMembers(ctx.prisma, input.organizationId);

      if (!members.some((m) => m.userId === input.userId)) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "That user is not a member of this workspace",
        });
      }

      assertNotLastOwner(members, input.userId);

      await ctx.prisma.organizationMember.delete({
        where: {
          userId_organizationId: {
            userId: input.userId,
            organizationId: input.organizationId,
          },
        },
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        organizationId: input.organizationId,
        action: AUDIT_ACTIONS.ADMIN_TEAM_MEMBER_REMOVED,
        entityType: "OrganizationMember",
        entityId: `${input.organizationId}:${input.userId}`,
        metadata: { removedUserId: input.userId },
      }).catch(() => {});

      return { success: true };
    }),

  /** MEMBER <-> ADMIN only. OWNER is never read or written here. */
  updateMemberRole: superAdminProcedure
    .input(
      z.object({
        organizationId: z.string(),
        userId: z.string(),
        role: assignableRole,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const members = await loadMembers(ctx.prisma, input.organizationId);

      if (!members.some((m) => m.userId === input.userId)) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "That user is not a member of this workspace",
        });
      }

      // Demoting the sole OWNER would leave the org unrecoverable (OWNER is not
      // assignable through this router).
      assertNotLastOwner(members, input.userId);

      const membership = await ctx.prisma.organizationMember.update({
        where: {
          userId_organizationId: {
            userId: input.userId,
            organizationId: input.organizationId,
          },
        },
        data: { role: input.role },
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        organizationId: input.organizationId,
        action: AUDIT_ACTIONS.ADMIN_TEAM_MEMBER_ROLE_CHANGED,
        entityType: "OrganizationMember",
        entityId: membership.id,
        metadata: { targetUserId: input.userId, newRole: input.role },
      }).catch(() => {});

      return membership;
    }),
});
