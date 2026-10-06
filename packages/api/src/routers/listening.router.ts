import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, adminOrgProcedure } from "../trpc";
import { listeningSyncQueue, listeningSyncJobId } from "@postautomation/queue";
import { requirePlan } from "../middleware/plan-limit.middleware";
import { MentionSource } from "@postautomation/db";

export const listeningRouter = createRouter({
  // ---- Listening Queries CRUD ----
  listQueries: adminOrgProcedure.query(async ({ ctx }) => {
    // Listening is a STARTER+ feature
    await requirePlan(ctx.organizationId, "STARTER", "Listening", ctx.isSuperAdmin);
    return ctx.prisma.listeningQuery.findMany({
      where: { organizationId: ctx.organizationId },
      include: {
        _count: { select: { mentions: true, alerts: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }),

  getQuery: adminOrgProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.listeningQuery.findFirstOrThrow({
        where: { id: input.id, organizationId: ctx.organizationId },
        include: {
          _count: { select: { mentions: true, alerts: true } },
        },
      });
    }),

  createQuery: adminOrgProcedure
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

      // Trigger initial sync — best-effort: a queue blip must not fail the
      // create; the 30-minute cron picks the query up regardless.
      try {
        await listeningSyncQueue.add(
          `listening-sync-${query.id}`,
          { listeningQueryId: query.id, organizationId: ctx.organizationId },
          { jobId: listeningSyncJobId(query.id, "create"), removeOnComplete: true, removeOnFail: 100 }
        );
      } catch (err) {
        console.warn(`[listening.createQuery] initial sync enqueue failed for ${query.id}:`, err);
      }

      return query;
    }),

  updateQuery: adminOrgProcedure
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

  deleteQuery: adminOrgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.listeningQuery.delete({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      return { success: true };
    }),

  // ---- Mentions ----
  mentions: adminOrgProcedure
    .input(
      z.object({
        queryId: z.string().optional(),
        sentiment: z.enum(["POSITIVE", "NEGATIVE", "NEUTRAL", "MIXED"]).optional(),
        /** One source (2026-10-06: validated against the enum — a bad value is a 400, not a Prisma 500). */
        source: z.nativeEnum(MentionSource).optional(),
        /**
         * "recent" (newest first) or "reach" (most reach/views first, 2026-10-06).
         * Reach is what the source reports — views (YouTube, TikTok),
         * impressions (X), upvotes (Reddit posts) — and 0 where it reports none.
         */
        sort: z.enum(["recent", "reach"]).default("recent"),
        /** Only mentions with at least this much reach (0 = no minimum). */
        minReach: z.number().int().min(0).max(1_000_000_000).default(0),
        /** Only mentions from the last N days (omitted = all stored). */
        days: z.number().int().min(1).max(365).optional(),
        limit: z.number().min(1).max(100).default(50),
        /** The last item's id from the previous page. */
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      // Scope to org whether or not a specific queryId is provided
      const queryFilter = input.queryId
        ? { listeningQueryId: input.queryId, listeningQuery: { organizationId: ctx.organizationId } }
        : { listeningQuery: { organizationId: ctx.organizationId } };

      const mentions = await ctx.prisma.mention.findMany({
        where: {
          ...queryFilter,
          ...(input.sentiment ? { sentiment: input.sentiment } : {}),
          ...(input.source ? { source: input.source } : {}),
          ...(input.minReach > 0 ? { reach: { gte: input.minReach } } : {}),
          ...(input.days ? { mentionedAt: { gte: new Date(Date.now() - input.days * 24 * 60 * 60 * 1000) } } : {}),
        },
        // A total order (id breaks ties), so cursor pages never skip or repeat a row.
        orderBy: mentionsOrderBy(input.sort),
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });

      const hasMore = mentions.length > input.limit;
      const items = hasMore ? mentions.slice(0, -1) : mentions;

      return {
        items,
        nextCursor: hasMore ? items[items.length - 1]?.id : undefined,
      };
    }),

  // ---- Sentiment Overview ----
  sentimentOverview: adminOrgProcedure
    .input(
      z.object({
        queryId: z.string().optional(),
        days: z.number().default(30),
      })
    )
    .query(async ({ ctx, input }) => {
      const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);

      const queryFilter = input.queryId
        ? { listeningQueryId: input.queryId, listeningQuery: { organizationId: ctx.organizationId } }
        : { listeningQuery: { organizationId: ctx.organizationId } };

      // Two statements instead of seven: one GROUP BY sentiment for the
      // counts, one aggregate for the sums/average. The page polls this, so
      // the round trips were paid every 15s per open tab.
      const [bySentiment, totals] = await Promise.all([
        ctx.prisma.mention.groupBy({
          by: ["sentiment"],
          where: { ...queryFilter, mentionedAt: { gte: since } },
          _count: { _all: true },
        }),
        ctx.prisma.mention.aggregate({
          where: { ...queryFilter, mentionedAt: { gte: since } },
          _sum: { reach: true, engagements: true },
          // _avg ignores NULL sentimentScore (unscored rows) by SQL semantics,
          // so this equals the old `sentimentScore: { not: null }` average.
          _avg: { sentimentScore: true },
        }),
      ]);
      const countOf = (s: "POSITIVE" | "NEGATIVE" | "NEUTRAL" | "MIXED") =>
        bySentiment.find((g) => g.sentiment === s)?._count._all ?? 0;
      const positive = countOf("POSITIVE");
      const negative = countOf("NEGATIVE");
      const neutral = countOf("NEUTRAL");
      const mixed = countOf("MIXED");

      return {
        positive,
        negative,
        neutral,
        mixed,
        total: positive + negative + neutral + mixed,
        avgSentimentScore: totals._avg.sentimentScore ?? 0,
        totalReach: totals._sum.reach ?? 0,
        totalEngagements: totals._sum.engagements ?? 0,
      };
    }),

  // ---- Mention Volume Over Time ----
  volumeOverTime: adminOrgProcedure
    .input(
      z.object({
        queryId: z.string().optional(),
        days: z.number().default(30),
      })
    )
    .query(async ({ ctx, input }) => {
      const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);

      // IDOR fix (audit 2026-06-19 / H6): always anchor to the acting org, even
      // when a specific queryId is supplied — mirrors mentions/sentimentOverview.
      const queryFilter = input.queryId
        ? { listeningQueryId: input.queryId, listeningQuery: { organizationId: ctx.organizationId } }
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
  alerts: adminOrgProcedure
    .input(
      z.object({
        queryId: z.string().optional(),
        unreadOnly: z.boolean().default(false),
      })
    )
    .query(async ({ ctx, input }) => {
      const queryFilter = input.queryId
        ? { listeningQueryId: input.queryId, listeningQuery: { organizationId: ctx.organizationId } }
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

  markAlertRead: adminOrgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.prisma.sentimentAlert.updateMany({
        where: { id: input.id, listeningQuery: { organizationId: ctx.organizationId } },
        data: { isRead: true },
      });
      if (result.count === 0) throw new TRPCError({ code: "NOT_FOUND" });
      return { success: true };
    }),

  // ---- Source Breakdown ----
  sourceBreakdown: adminOrgProcedure
    .input(
      z.object({
        queryId: z.string().optional(),
        days: z.number().default(30),
      })
    )
    .query(async ({ ctx, input }) => {
      const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);

      const queryFilter = input.queryId
        ? { listeningQueryId: input.queryId, listeningQuery: { organizationId: ctx.organizationId } }
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
  triggerSync: adminOrgProcedure
    .input(z.object({ queryId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.listeningQuery.findFirstOrThrow({
        where: { id: input.queryId, organizationId: ctx.organizationId },
      });
      // Minute-bucketed id: a double click (or two users) inside one minute
      // is ONE sweep of the platform APIs, not two.
      await listeningSyncQueue.add(
        `listening-sync-manual-${input.queryId}`,
        { listeningQueryId: input.queryId, organizationId: ctx.organizationId },
        { jobId: listeningSyncJobId(input.queryId, "manual"), removeOnComplete: true, removeOnFail: 100 }
      );
      return { queued: true };
    }),
});

/** Mention feed order: newest first, or most reach first (newest first among equals). Always ends on id. */
export function mentionsOrderBy(sort: "recent" | "reach") {
  return sort === "reach"
    ? [{ reach: "desc" as const }, { mentionedAt: "desc" as const }, { id: "desc" as const }]
    : [{ mentionedAt: "desc" as const }, { id: "desc" as const }];
}
