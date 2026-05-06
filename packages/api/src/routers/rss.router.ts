import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { rssSyncQueue } from "@postautomation/queue";

// SECURITY: every mutation/query is org-scoped via `orgProcedure`. Each
// lookup adds `organizationId: ctx.organizationId` so a user from org A
// cannot read/modify org B's RSS feeds (previously this was vulnerable —
// `findUnique({ where: { id } })` without org scope = IDOR).

export const rssRouter = createRouter({
  list: orgProcedure.query(async ({ ctx }) => {
    const feeds = await ctx.prisma.rssFeed.findMany({
      where: { organizationId: ctx.organizationId },
      include: {
        _count: { select: { entries: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return feeds;
  }),

  create: orgProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        url: z.string().url(),
        checkInterval: z.number().min(5).max(1440).default(60),
        autoPost: z.boolean().default(false),
        targetChannels: z.array(z.string()).default([]),
        promptTemplate: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const feed = await ctx.prisma.rssFeed.create({
        data: {
          organizationId: ctx.organizationId,
          name: input.name,
          url: input.url,
          checkInterval: input.checkInterval,
          autoPost: input.autoPost,
          targetChannels: input.targetChannels,
          promptTemplate: input.promptTemplate,
        },
      });
      return feed;
    }),

  update: orgProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(255).optional(),
        url: z.string().url().optional(),
        checkInterval: z.number().min(5).max(1440).optional(),
        autoPost: z.boolean().optional(),
        isActive: z.boolean().optional(),
        targetChannels: z.array(z.string()).optional(),
        promptTemplate: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      // Org-scoped existence check
      const existing = await ctx.prisma.rssFeed.findFirst({
        where: { id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "RSS feed not found" });
      }
      const feed = await ctx.prisma.rssFeed.update({
        where: { id },
        data,
      });
      return feed;
    }),

  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.rssFeed.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "RSS feed not found" });
      }
      await ctx.prisma.rssFeed.delete({ where: { id: input.id } });
      return { success: true };
    }),

  getEntries: orgProcedure
    .input(
      z.object({
        feedId: z.string(),
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      // Verify feed belongs to caller's org before returning entries.
      const feed = await ctx.prisma.rssFeed.findFirst({
        where: { id: input.feedId, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!feed) {
        throw new TRPCError({ code: "NOT_FOUND", message: "RSS feed not found" });
      }
      const entries = await ctx.prisma.rssFeedEntry.findMany({
        where: { feedId: input.feedId },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      });

      let nextCursor: string | undefined;
      if (entries.length > input.limit) {
        const lastItem = entries.pop();
        nextCursor = lastItem?.id;
      }

      return { entries, nextCursor };
    }),

  checkNow: orgProcedure
    .input(
      z.object({
        feedId: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // SECURITY: derive organizationId from session, NOT from input —
      // previously the client could pass an arbitrary organizationId here
      // and trigger sync jobs against another tenant.
      const feed = await ctx.prisma.rssFeed.findFirst({
        where: { id: input.feedId, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!feed) {
        throw new TRPCError({ code: "NOT_FOUND", message: "RSS feed not found" });
      }
      await rssSyncQueue.add(`rss-sync-${input.feedId}`, {
        feedId: input.feedId,
        organizationId: ctx.organizationId,
      });
      return { success: true, message: "RSS sync job enqueued" };
    }),
});
