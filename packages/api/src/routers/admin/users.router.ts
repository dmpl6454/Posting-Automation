import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { SignJWT } from "jose";
import { createRouter, superAdminProcedure } from "../../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../../lib/audit";

export const adminUsersRouter = createRouter({
  list: superAdminProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
        search: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { limit, cursor, search } = input;

      const where: any = {};
      if (search) {
        where.OR = [
          { name: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
        ];
      }

      const items = await ctx.prisma.user.findMany({
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        where,
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          isSuperAdmin: true,
          isBanned: true,
          createdAt: true,
          _count: { select: { memberships: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      let nextCursor: string | undefined;
      if (items.length > limit) {
        const next = items.pop()!;
        nextCursor = next.id;
      }

      return { items, nextCursor };
    }),

  getById: superAdminProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const user = await ctx.prisma.user.findUnique({
        where: { id: input.id },
        include: {
          memberships: {
            include: {
              organization: {
                select: { id: true, name: true, slug: true, plan: true },
              },
            },
          },
        },
      });
      if (!user) throw new TRPCError({ code: "NOT_FOUND" });
      return user;
    }),

  toggleSuperAdmin: superAdminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.prisma.user.findUnique({
        where: { id: input.userId },
        select: { isSuperAdmin: true },
      });
      if (!user) throw new TRPCError({ code: "NOT_FOUND" });

      // Guard against demoting the last super admin
      if (user.isSuperAdmin) {
        const superAdminCount = await ctx.prisma.user.count({
          where: { isSuperAdmin: true, deletedAt: null },
        });
        if (superAdminCount <= 1) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot demote the last super admin",
          });
        }
      }

      const updated = await ctx.prisma.user.update({
        where: { id: input.userId },
        data: { isSuperAdmin: !user.isSuperAdmin },
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.ADMIN_USER_SUPERADMIN_TOGGLED,
        entityType: "User",
        entityId: input.userId,
        metadata: { newValue: updated.isSuperAdmin },
      }).catch(() => {});

      return updated;
    }),

  toggleBan: superAdminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.prisma.user.findUnique({
        where: { id: input.userId },
        select: { isBanned: true },
      });
      if (!user) throw new TRPCError({ code: "NOT_FOUND" });

      const updated = await ctx.prisma.user.update({
        where: { id: input.userId },
        data: { isBanned: !user.isBanned },
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        action: updated.isBanned
          ? AUDIT_ACTIONS.ADMIN_USER_BANNED
          : AUDIT_ACTIONS.ADMIN_USER_UNBANNED,
        entityType: "User",
        entityId: input.userId,
      }).catch(() => {});

      return updated;
    }),

  delete: superAdminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: input.userId },
          data: { deletedAt: new Date() },
        });
        await tx.organizationMember.deleteMany({
          where: { userId: input.userId },
        });
        await tx.session.deleteMany({
          where: { userId: input.userId },
        });
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.ADMIN_USER_DELETED,
        entityType: "User",
        entityId: input.userId,
      }).catch(() => {});

      return { success: true };
    }),

  impersonate: superAdminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const target = await ctx.prisma.user.findUnique({
        where: { id: input.userId },
        select: { isSuperAdmin: true },
      });
      if (!target) throw new TRPCError({ code: "NOT_FOUND" });
      if (target.isSuperAdmin) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot impersonate a super admin",
        });
      }

      const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET);
      const token = await new SignJWT({
        impersonatedUserId: input.userId,
        adminUserId: (ctx.session.user as any).id,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setExpirationTime("1h")
        .sign(secret);

      createAuditLog({
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.ADMIN_USER_IMPERSONATED,
        entityType: "User",
        entityId: input.userId,
      }).catch(() => {});

      return { token };
    }),

  stopImpersonation: superAdminProcedure.mutation(() => {
    return { success: true };
  }),
});
