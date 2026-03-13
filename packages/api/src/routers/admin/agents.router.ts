import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, superAdminProcedure } from "../../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../../lib/audit";

export const adminAgentsRouter = createRouter({
  list: superAdminProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { limit, cursor } = input;

      const items = await ctx.prisma.agent.findMany({
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: {
          organization: { select: { id: true, name: true } },
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
      const agent = await ctx.prisma.agent.findUnique({
        where: { id: input.id },
        include: {
          organization: { select: { id: true, name: true } },
          runs: {
            take: 20,
            orderBy: { startedAt: "desc" },
          },
        },
      });
      if (!agent) throw new TRPCError({ code: "NOT_FOUND" });
      return agent;
    }),

  toggleActive: superAdminProcedure
    .input(z.object({ agentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const agent = await ctx.prisma.agent.findUnique({
        where: { id: input.agentId },
        select: { isActive: true },
      });
      if (!agent) throw new TRPCError({ code: "NOT_FOUND" });

      const updated = await ctx.prisma.agent.update({
        where: { id: input.agentId },
        data: { isActive: !agent.isActive },
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.ADMIN_AGENT_TOGGLED,
        entityType: "Agent",
        entityId: input.agentId,
        metadata: { isActive: updated.isActive },
      }).catch(() => {});

      return updated;
    }),

  delete: superAdminProcedure
    .input(z.object({ agentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.agent.delete({ where: { id: input.agentId } });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.ADMIN_AGENT_DELETED,
        entityType: "Agent",
        entityId: input.agentId,
      }).catch(() => {});

      return { success: true };
    }),
});
