import { z } from "zod";
import { createRouter, orgProcedure } from "../trpc";
import { listeningSyncQueue } from "@postautomation/queue";

export const listeningRouter = createRouter({
  // ---- Listening Queries CRUD ----
  listQueries: orgProcedure.query(async ({ ctx }) => {
    return ctx.prisma.listeningQuery.findMany({
      where: { organizationId: ctx.organizationId },
      include: {
        _count: { select: { mentions: true, alerts: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }),

  getQuery: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.listeningQuery.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          _count: { select: { mentions: true, alerts: true } },
        },
      });
    }),

  createQuery: orgProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200),
        keywords: z.array(z.string()).min(1),
        excludeWords: z.array(z.string()).default([]),
        platforms: z.array(z.string()).default([]),
        language: z.string().default("en"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const query = await ctx.prisma.listeningQuery.create({
        data: {
          organizationId: ctx.organizationId,
          ...input,
        },
      });

      // Trigger initial sync
      await listeningSyncQueue.add(
        `listening-sync-${query.id}`,
        { listeningQueryId: query.id, organizationId: ctx.organizationId },
        { removeOnComplete: true, removeOnFail: 100 }
      );

      return query;
    }),

  updateQuery: orgProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(200).optional(),
        keywords: z.array(z.string()).optional(),
        excludeWords: z.array(z.string()).optional(),
        platforms: z.array(z.string()).optional(),
        language: z.string().optional(),
        isActive: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      return ctx.prisma.listeningQuery.update({
        where: { id, organizationId: ctx.organizationId },
        data,
      });
    }),

  deleteQuery: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.listeningQuery.delete({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      return { success: true };
    }),

  // ---- Mentions ----
  mentions: orgProcedure
    .input(
      z.object({
        queryId: z.string().optional(),
        sentiment: z.enum(["POSITIVE", "NEGATIVE", "NEUTRAL", "MIXED"]).optional(),
        source: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      // Verify query belongs to org if specified
      const queryFilter = input.queryId
        ? { listeningQueryId: input.queryId }
        : {
            listeningQuery: { organizationId: ctx.organizationId },
          };

      const mentions = await ctx.prisma.mention.findMany({
        where: {
          ...queryFilter,
          ...(input.sentiment ? { sentiment: input.sentiment } : {}),
          ...(input.source ? { source: input.source as any } : {}),
          ...(input.cursor ? { id: { lt: input.cursor } } : {}),
        },
        orderBy: { mentionedAt: "desc" },
        take: input.limit + 1,
      });

      const hasMore = mentions.length > input.limit;
      const items = hasMore ? mentions.slice(0, -1) : mentions;

      return {
        items,
        nextCursor: hasMore ? items[items.length - 1]?.id : undefined,
      };
    }),

  // ---- Sentiment Overview ----
  sentimentOverview: orgProcedure
    .input(
      z.object({
        queryId: z.string().optional(),
        days: z.number().default(30),
      })
    )
    .query(async ({ ctx, input }) => {
      const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);

      const queryFilter = input.queryId
        ? { listeningQueryId: input.queryId }
        : { listeningQuery: { organizationId: ctx.organizationId } };

      const [positive, negative, neutral, mixed, total] = await Promise.all([
        ctx.prisma.mention.count({
          where: { ...queryFilter, sentiment: "POSITIVE", mentionedAt: { gte: since } },
        }),
        ctx.prisma.mention.count({
          where: { ...queryFilter, sentiment: "NEGATIVE", mentionedAt: { gte: since } },
        }),
        ctx.prisma.mention.count({
          where: { ...queryFilter, sentiment: "NEUTRAL", mentionedAt: { gte: since } },
        }),
        ctx.prisma.mention.count({
          where: { ...queryFilter, sentiment: "MIXED", mentionedAt: { gte: since } },
        }),
        ctx.prisma.mention.count({
          where: { ...queryFilter, mentionedAt: { gte: since } },
        }),
      ]);

      // Avg sentiment score
      const avgResult = await ctx.prisma.mention.aggregate({
        where: { ...queryFilter, mentionedAt: { gte: since }, sentimentScore: { not: null } },
        _avg: { sentimentScore: true },
      });

      // Total reach & engagements
      const engagementResult = await ctx.prisma.mention.aggregate({
        where: { ...queryFilter, mentionedAt: { gte: since } },
        _sum: { reach: true, engagements: true },
      });

      return {
        positive,
        negative,
        neutral,
        mixed,
        total,
        avgSentimentScore: avgResult._avg.sentimentScore ?? 0,
        totalReach: engagementResult._sum.reach ?? 0,
        totalEngagements: engagementResult._sum.engagements ?? 0,
      };
    }),

  // ---- Mention Volume Over Time ----
  volumeOverTime: orgProcedure
    .input(
      z.object({
        queryId: z.string().optional(),
        days: z.number().default(30),
      })
    )
    .query(async ({ ctx, input }) => {
      const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);

      const queryFilter = input.queryId
        ? { listeningQueryId: input.queryId }
        : { listeningQuery: { organizationId: ctx.organizationId } };

      const mentions = await ctx.prisma.mention.findMany({
        where: { ...queryFilter, mentionedAt: { gte: since } },
        select: { mentionedAt: true, sentiment: true },
        orderBy: { mentionedAt: "asc" },
      });

      const grouped: Record<string, { total: number; positive: number; negative: number; neutral: number }> = {};
      for (const m of mentions) {
        const day = m.mentionedAt.toISOString().split("T")[0]!;
        if (!grouped[day]) grouped[day] = { total: 0, positive: 0, negative: 0, neutral: 0 };
        grouped[day].total++;
        if (m.sentiment === "POSITIVE") grouped[day].positive++;
        else if (m.sentiment === "NEGATIVE") grouped[day].negative++;
        else grouped[day].neutral++;
      }

      const result: Array<{ date: string; total: number; positive: number; negative: number; neutral: number }> = [];
      const current = new Date(since);
      const now = new Date();
      while (current <= now) {
        const key = current.toISOString().split("T")[0]!;
        result.push({ date: key, ...(grouped[key] ?? { total: 0, positive: 0, negative: 0, neutral: 0 }) });
        current.setDate(current.getDate() + 1);
      }
      return result;
    }),

  // ---- Alerts ----
  alerts: orgProcedure
    .input(
      z.object({
        queryId: z.string().optional(),
        unreadOnly: z.boolean().default(false),
      })
    )
    .query(async ({ ctx, input }) => {
      const queryFilter = input.queryId
        ? { listeningQueryId: input.queryId }
        : { listeningQuery: { organizationId: ctx.organizationId } };

      return ctx.prisma.sentimentAlert.findMany({
        where: {
          ...queryFilter,
          ...(input.unreadOnly ? { isRead: false } : {}),
        },
        include: {
          listeningQuery: { select: { name: true } },
        },
        orderBy: { triggeredAt: "desc" },
        take: 50,
      });
    }),

  markAlertRead: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.sentimentAlert.update({
        where: { id: input.id },
        data: { isRead: true },
      });
    }),

  // ---- Source Breakdown ----
  sourceBreakdown: orgProcedure
    .input(
      z.object({
        queryId: z.string().optional(),
        days: z.number().default(30),
      })
    )
    .query(async ({ ctx, input }) => {
      const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);

      const queryFilter = input.queryId
        ? { listeningQueryId: input.queryId }
        : { listeningQuery: { organizationId: ctx.organizationId } };

      const mentions = await ctx.prisma.mention.groupBy({
        by: ["source"],
        where: { ...queryFilter, mentionedAt: { gte: since } },
        _count: true,
        _sum: { reach: true, engagements: true },
      });

      return mentions.map((m) => ({
        source: m.source,
        count: m._count,
        reach: m._sum.reach ?? 0,
        engagements: m._sum.engagements ?? 0,
      })).sort((a, b) => b.count - a.count);
    }),

  // ---- Trigger Manual Sync ----
  triggerSync: orgProcedure
    .input(z.object({ queryId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.listeningQuery.findFirstOrThrow({
        where: { id: input.queryId, organizationId: ctx.organizationId },
      });
      await listeningSyncQueue.add(
        `listening-sync-manual-${input.queryId}`,
        { listeningQueryId: input.queryId, organizationId: ctx.organizationId },
        { removeOnComplete: true, removeOnFail: 100 }
      );
      return { queued: true };
    }),
});
