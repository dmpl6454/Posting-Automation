import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { agentRunQueue } from "@postautomation/queue";

export const agentRouter = createRouter({
  list: orgProcedure.query(async ({ ctx }) => {
    return ctx.prisma.agent.findMany({
      where: { organizationId: ctx.organizationId },
      include: {
        _count: { select: { runs: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }),

  getById: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const agent = await ctx.prisma.agent.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          runs: {
            orderBy: { startedAt: "desc" },
            take: 10,
          },
        },
      });
      // Resolve channel details from channelIds
      let channels: any[] = [];
      if (agent && agent.channelIds.length > 0) {
        channels = await ctx.prisma.channel.findMany({
          where: { id: { in: agent.channelIds } },
          select: { id: true, name: true, platform: true, username: true },
        });
      }
      if (!agent) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      }
      return { ...agent, channels };
    }),

  create: orgProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        aiProvider: z.enum(["openai", "anthropic", "gemini"]).default("anthropic"),
        niche: z.string(),
        topics: z.array(z.string()),
        tone: z.enum(["professional", "casual", "humorous", "formal", "inspiring"]).default("professional"),
        language: z.string().default("english"),
        frequency: z.enum(["daily", "weekdays", "weekly", "custom"]).default("daily"),
        postsPerDay: z.number().min(1).max(10).default(1),
        cronExpression: z.string().default("0 9 * * *"),
        channelIds: z.array(z.string()).min(1),
        customPrompt: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const agent = await ctx.prisma.agent.create({
        data: {
          organizationId: ctx.organizationId,
          name: input.name,
          aiProvider: input.aiProvider,
          niche: input.niche,
          topics: input.topics,
          tone: input.tone,
          language: input.language,
          frequency: input.frequency,
          postsPerDay: input.postsPerDay,
          cronExpression: input.cronExpression,
          channelIds: input.channelIds,
          customPrompt: input.customPrompt,
        },
      });
      return agent;
    }),

  update: orgProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(255).optional(),
        aiProvider: z.enum(["openai", "anthropic", "gemini"]).optional(),
        niche: z.string().optional(),
        topics: z.array(z.string()).optional(),
        tone: z.enum(["professional", "casual", "humorous", "formal", "inspiring"]).optional(),
        language: z.string().optional(),
        frequency: z.enum(["daily", "weekdays", "weekly", "custom"]).optional(),
        postsPerDay: z.number().min(1).max(10).optional(),
        cronExpression: z.string().optional(),
        channelIds: z.array(z.string()).optional(),
        customPrompt: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const existing = await ctx.prisma.agent.findFirst({
        where: { id, organizationId: ctx.organizationId },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      }
      return ctx.prisma.agent.update({
        where: { id },
        data,
      });
    }),

  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.agent.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      }
      await ctx.prisma.agent.delete({ where: { id: input.id } });
      return { success: true };
    }),

  toggle: orgProcedure
    .input(z.object({ id: z.string(), isActive: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const agent = await ctx.prisma.agent.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      if (!agent) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      }
      return ctx.prisma.agent.update({
        where: { id: input.id },
        data: { isActive: input.isActive },
      });
    }),

  runNow: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const agent = await ctx.prisma.agent.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      if (!agent) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      }
      await agentRunQueue.add(`agent-run-${input.id}`, {
        agentId: input.id,
        organizationId: ctx.organizationId,
      });
      return { queued: true };
    }),

  runs: orgProcedure
    .input(
      z.object({
        agentId: z.string(),
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      // Verify agent belongs to org
      const agent = await ctx.prisma.agent.findFirst({
        where: { id: input.agentId, organizationId: ctx.organizationId },
      });
      if (!agent) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
      }
      return ctx.prisma.agentRun.findMany({
        where: { agentId: input.agentId },
        orderBy: { startedAt: "desc" },
        take: input.limit,
      });
    }),
});
