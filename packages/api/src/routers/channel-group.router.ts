import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";

export const channelGroupRouter = createRouter({
  list: orgProcedure.query(async ({ ctx }) => {
    return ctx.prisma.channelGroup.findMany({
      where: { organizationId: ctx.organizationId },
      include: {
        channels: {
          select: { id: true, name: true, platform: true, username: true, avatar: true, isActive: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });
  }),

  create: orgProcedure
    .input(z.object({ name: z.string().min(1).max(50), color: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      // Fix #20: include channels in return so the UI doesn't dereference undefined
      return ctx.prisma.channelGroup.create({
        data: {
          organizationId: ctx.organizationId,
          name: input.name,
          color: input.color ?? "#6366f1",
        },
        include: {
          channels: {
            select: { id: true, name: true, platform: true, username: true, avatar: true, isActive: true },
          },
        },
      });
    }),

  update: orgProcedure
    .input(z.object({ id: z.string(), name: z.string().min(1).max(50).optional(), color: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const group = await ctx.prisma.channelGroup.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      if (!group) throw new TRPCError({ code: "NOT_FOUND" });
      return ctx.prisma.channelGroup.update({
        where: { id: input.id },
        data: { ...(input.name && { name: input.name }), ...(input.color && { color: input.color }) },
      });
    }),

  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const group = await ctx.prisma.channelGroup.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      if (!group) throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.prisma.channelGroup.delete({ where: { id: input.id } });
      return { success: true };
    }),

  addChannel: orgProcedure
    .input(z.object({ groupId: z.string(), channelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const group = await ctx.prisma.channelGroup.findFirst({
        where: { id: input.groupId, organizationId: ctx.organizationId },
      });
      if (!group) throw new TRPCError({ code: "NOT_FOUND" });
      // Security: validate the channel belongs to this org before connecting it,
      // otherwise an arbitrary cross-org channelId could be added to the group (IDOR).
      const channel = await ctx.prisma.channel.findFirst({
        where: { id: input.channelId, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!channel) throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found in this workspace." });
      return ctx.prisma.channelGroup.update({
        where: { id: input.groupId },
        data: { channels: { connect: { id: input.channelId } } },
        include: { channels: { select: { id: true, name: true, platform: true } } },
      });
    }),

  removeChannel: orgProcedure
    .input(z.object({ groupId: z.string(), channelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const group = await ctx.prisma.channelGroup.findFirst({
        where: { id: input.groupId, organizationId: ctx.organizationId },
      });
      if (!group) throw new TRPCError({ code: "NOT_FOUND" });
      // Security: validate the channel belongs to this org before disconnecting it,
      // mirroring addChannel so arbitrary cross-org channelIds are rejected (IDOR).
      const channel = await ctx.prisma.channel.findFirst({
        where: { id: input.channelId, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!channel) throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found in this workspace." });
      return ctx.prisma.channelGroup.update({
        where: { id: input.groupId },
        data: { channels: { disconnect: { id: input.channelId } } },
        include: { channels: { select: { id: true, name: true, platform: true } } },
      });
    }),
});
