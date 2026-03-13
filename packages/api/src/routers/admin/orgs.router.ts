import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, superAdminProcedure } from "../../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../../lib/audit";

export const adminOrgsRouter = createRouter({
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
          { slug: { contains: search, mode: "insensitive" } },
        ];
      }

      const items = await ctx.prisma.organization.findMany({
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        where,
        include: {
          _count: {
            select: { members: true, posts: true, channels: true },
          },
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
      const org = await ctx.prisma.organization.findUnique({
        where: { id: input.id },
        include: {
          members: {
            include: {
              user: {
                select: { id: true, name: true, email: true, image: true },
              },
            },
          },
          channels: true,
          posts: {
            take: 10,
            orderBy: { createdAt: "desc" },
          },
        },
      });
      if (!org) throw new TRPCError({ code: "NOT_FOUND" });
      return org;
    }),

  changePlan: superAdminProcedure
    .input(
      z.object({
        organizationId: z.string(),
        plan: z.enum(["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const org = await ctx.prisma.organization.update({
        where: { id: input.organizationId },
        data: { plan: input.plan },
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        organizationId: input.organizationId,
        action: AUDIT_ACTIONS.ADMIN_ORG_PLAN_CHANGED,
        entityType: "Organization",
        entityId: input.organizationId,
        metadata: { newPlan: input.plan },
      }).catch(() => {});

      return org;
    }),

  delete: superAdminProcedure
    .input(z.object({ organizationId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.organization.delete({
        where: { id: input.organizationId },
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        organizationId: input.organizationId,
        action: AUDIT_ACTIONS.ADMIN_ORG_DELETED,
        entityType: "Organization",
        entityId: input.organizationId,
      }).catch(() => {});

      return { success: true };
    }),
});
