import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";

export const accountGroupRouter = createRouter({
  // List all account groups with their agents
  list: orgProcedure.query(async ({ ctx }) => {
    return ctx.prisma.accountGroup.findMany({
      where: { organizationId: ctx.organizationId },
      include: {
        agents: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }),

  // Create a new account group
  create: orgProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        topics: z.array(z.string()),
        trendScoreThreshold: z.number().min(0).max(100).default(40),
        skipReviewGate: z.boolean().default(false),
        postsPerDay: z.number().min(1).max(50).default(3),
        timezone: z.string().default("UTC"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.accountGroup.create({
        data: {
          organizationId: ctx.organizationId,
          name: input.name,
          topics: input.topics,
          trendScoreThreshold: input.trendScoreThreshold,
          skipReviewGate: input.skipReviewGate,
          postsPerDay: input.postsPerDay,
          timezone: input.timezone,
        },
      });
    }),

  // Update an account group
  update: orgProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(255).optional(),
        topics: z.array(z.string()).optional(),
        trendScoreThreshold: z.number().min(0).max(100).optional(),
        skipReviewGate: z.boolean().optional(),
        postsPerDay: z.number().min(1).max(50).optional(),
        timezone: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const existing = await ctx.prisma.accountGroup.findFirst({
        where: { id, organizationId: ctx.organizationId },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Account group not found",
        });
      }
      return ctx.prisma.accountGroup.update({
        where: { id },
        data,
      });
    }),

  // Delete an account group (unlink agents first)
  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.accountGroup.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Account group not found",
        });
      }

      // Unlink agents first
      await ctx.prisma.agent.updateMany({
        where: { accountGroupId: input.id },
        data: { accountGroupId: null },
      });

      await ctx.prisma.accountGroup.delete({ where: { id: input.id } });
      return { success: true };
    }),

  // Add agents to a group
  addAgents: orgProcedure
    .input(
      z.object({
        groupId: z.string(),
        agentIds: z.array(z.string()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const group = await ctx.prisma.accountGroup.findFirst({
        where: { id: input.groupId, organizationId: ctx.organizationId },
      });
      if (!group) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Account group not found",
        });
      }

      await ctx.prisma.agent.updateMany({
        where: {
          id: { in: input.agentIds },
          organizationId: ctx.organizationId,
        },
        data: { accountGroupId: input.groupId },
      });

      return { success: true };
    }),

  // Remove an agent from its group
  removeAgent: orgProcedure
    .input(z.object({ agentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const agent = await ctx.prisma.agent.findFirst({
        where: { id: input.agentId, organizationId: ctx.organizationId },
      });
      if (!agent) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Agent not found",
        });
      }

      await ctx.prisma.agent.update({
        where: { id: input.agentId },
        data: { accountGroupId: null },
      });

      return { success: true };
    }),
});
