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

  /**
   * Batch add/remove for the group's "Select all" / "Remove all" buttons.
   *
   * Why this exists instead of looping `addChannel`: the group card fires one
   * mutation per channel, and this platform routinely has hundreds of channels
   * on one org (387 Facebook Pages on the account that prompted this). Looping
   * the singular procedure would fire hundreds of tRPC round-trips, trip the
   * rate limiter, and leave the group half-populated with no way to tell which
   * writes landed. One `update` with an array of connects is a single atomic
   * write — and Prisma's implicit-M:N connect/disconnect are idempotent, so
   * re-adding an existing member (or removing a non-member) is a harmless
   * no-op rather than an error.
   */
  setChannels: orgProcedure
    .input(
      z.object({
        groupId: z.string(),
        // The UI chunks to this size (GROUP_BATCH in the channels page), so
        // raising it here alone would not widen a batch.
        channelIds: z.array(z.string()).min(1).max(500),
        mode: z.enum(["add", "remove"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const group = await ctx.prisma.channelGroup.findFirst({
        where: { id: input.groupId, organizationId: ctx.organizationId },
      });
      if (!group) throw new TRPCError({ code: "NOT_FOUND" });

      // Security: same IDOR guard as the singular procedures, applied to the
      // whole batch. We use ONLY the ids that come back org-scoped — a foreign
      // or stale id is silently dropped rather than failing the entire batch,
      // so one disconnected channel can't block a 300-channel select-all.
      const owned = await ctx.prisma.channel.findMany({
        where: { id: { in: [...new Set(input.channelIds)] }, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (owned.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No channels found in this workspace." });
      }
      const ids = owned.map((c) => ({ id: c.id }));

      // Membership BEFORE the write, so `changed` reports rows actually added or
      // removed rather than ids submitted. connect/disconnect are idempotent, so
      // re-adding an existing member is a silent no-op — counting the input would
      // overstate it ("Added 300" when 299 were already members).
      const before = await ctx.prisma.channelGroup.findUnique({
        where: { id: input.groupId },
        select: { channels: { select: { id: true } } },
      });
      const beforeIds = new Set((before?.channels ?? []).map((c) => c.id));
      const changed = owned.filter((c) =>
        input.mode === "add" ? !beforeIds.has(c.id) : beforeIds.has(c.id)
      ).length;

      const updated = await ctx.prisma.channelGroup.update({
        where: { id: input.groupId },
        data: {
          channels: input.mode === "add" ? { connect: ids } : { disconnect: ids },
        },
        include: {
          channels: {
            select: { id: true, name: true, platform: true, username: true, avatar: true, isActive: true },
          },
        },
      });
      return { group: updated, changed };
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
