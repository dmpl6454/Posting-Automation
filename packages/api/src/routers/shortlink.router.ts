import crypto from "crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, protectedProcedure } from "../trpc";
import { prisma } from "@postautomation/db";

export const shortlinkRouter = createRouter({
  create: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
        originalUrl: z.string().url(),
        postId: z.string().optional(),
        expiresAt: z.string().datetime().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const code = crypto.randomBytes(4).toString("hex");

      const shortLink = await prisma.shortLink.create({
        data: {
          organizationId: input.organizationId,
          code,
          originalUrl: input.originalUrl,
          postId: input.postId,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        },
      });

      return shortLink;
    }),

  list: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const links = await prisma.shortLink.findMany({
        where: { organizationId: input.organizationId },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      });

      let nextCursor: string | undefined;
      if (links.length > input.limit) {
        const lastItem = links.pop();
        nextCursor = lastItem?.id;
      }

      return { links, nextCursor };
    }),

  getStats: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const shortLink = await prisma.shortLink.findUnique({
        where: { id: input.id },
      });
      if (!shortLink) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Short link not found" });
      }

      // Get clicks over the last 7 days grouped by day
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const clicks = await prisma.shortLinkClick.findMany({
        where: {
          shortLinkId: input.id,
          createdAt: { gte: sevenDaysAgo },
        },
        orderBy: { createdAt: "desc" },
      });

      // Group clicks by day
      const clicksByDay: Record<string, number> = {};
      for (let i = 0; i < 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const key = date.toISOString().split("T")[0] ?? "unknown";
        clicksByDay[key] = 0;
      }
      for (const click of clicks) {
        const key = click.createdAt.toISOString().split("T")[0] ?? "unknown";
        const currentCount = clicksByDay[key];
        if (currentCount !== undefined) {
          clicksByDay[key] = currentCount + 1;
        }
      }

      // Top referers
      const refererCounts: Record<string, number> = {};
      for (const click of clicks) {
        const referer = click.referer || "Direct";
        refererCounts[referer] = (refererCounts[referer] ?? 0) + 1;
      }
      const topReferers = Object.entries(refererCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .map(([referer, count]) => ({ referer, count }));

      // Countries
      const countryCounts: Record<string, number> = {};
      for (const click of clicks) {
        const country = click.country || "Unknown";
        countryCounts[country] = (countryCounts[country] ?? 0) + 1;
      }
      const topCountries = Object.entries(countryCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .map(([country, count]) => ({ country, count }));

      return {
        shortLink,
        clicksByDay: Object.entries(clicksByDay)
          .map(([date, count]) => ({ date, count }))
          .reverse(),
        topReferers,
        topCountries,
        totalClicks: shortLink.clicks,
      };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const shortLink = await prisma.shortLink.findUnique({
        where: { id: input.id },
      });
      if (!shortLink) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Short link not found" });
      }
      await prisma.shortLink.delete({ where: { id: input.id } });
      return { success: true };
    }),
});
