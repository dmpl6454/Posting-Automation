import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import { prisma } from "@postautomation/db";
import { rssSyncQueue } from "@postautomation/queue";

export const rssRouter = createRouter({
  list: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
      })
    )
    .query(async ({ input }) => {
      const feeds = await prisma.rssFeed.findMany({
        where: { organizationId: input.organizationId },
        include: {
          _count: { select: { entries: true } },
        },
        orderBy: { createdAt: "desc" },
      });
      return feeds;
    }),

  create: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
        name: z.string().min(1).max(255),
        url: z.string().url(),
        checkInterval: z.number().min(5).max(1440).default(60),
        autoPost: z.boolean().default(false),
        targetChannels: z.array(z.string()).default([]),
        promptTemplate: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const feed = await prisma.rssFeed.create({
        data: {
          organizationId: input.organizationId,
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

  update: protectedProcedure
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
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      const existing = await prisma.rssFeed.findUnique({ where: { id } });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "RSS feed not found" });
      }
      const feed = await prisma.rssFeed.update({
        where: { id },
        data,
      });
      return feed;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const existing = await prisma.rssFeed.findUnique({ where: { id: input.id } });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "RSS feed not found" });
      }
      await prisma.rssFeed.delete({ where: { id: input.id } });
      return { success: true };
    }),

  getEntries: protectedProcedure
    .input(
      z.object({
        feedId: z.string(),
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const entries = await prisma.rssFeedEntry.findMany({
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

  checkNow: protectedProcedure
    .input(
      z.object({
        feedId: z.string(),
        organizationId: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const feed = await prisma.rssFeed.findUnique({ where: { id: input.feedId } });
      if (!feed) {
        throw new TRPCError({ code: "NOT_FOUND", message: "RSS feed not found" });
      }
      await rssSyncQueue.add(`rss-sync-${input.feedId}`, {
        feedId: input.feedId,
        organizationId: input.organizationId,
      });
      return { success: true, message: "RSS sync job enqueued" };
    }),
});
