import { z } from "zod";
import { createRouter, orgProcedure } from "../trpc";
import { analyticsSyncQueue } from "@postautomation/queue";

export const analyticsRouter = createRouter({
  overview: orgProcedure
    .input(
      z.object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const from = input.from ? new Date(input.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const to = input.to ? new Date(input.to) : new Date();

      const posts = await ctx.prisma.post.findMany({
        where: {
          organizationId: ctx.organizationId,
          status: "PUBLISHED",
          publishedAt: { gte: from, lte: to },
        },
        include: { targets: true },
      });

      const totalPosts = posts.length;
      const totalTargets = posts.reduce((sum: number, p: any) => sum + p.targets.length, 0);
      const published = posts.reduce(
        (sum: number, p: any) => sum + p.targets.filter((t: any) => t.status === "PUBLISHED").length,
        0
      );
      const failed = posts.reduce(
        (sum: number, p: any) => sum + p.targets.filter((t: any) => t.status === "FAILED").length,
        0
      );

      return { totalPosts, totalTargets, published, failed, period: { from, to } };
    }),

  /** Aggregated engagement metrics across all published posts */
  engagement: orgProcedure
    .input(
      z.object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const from = input.from ? new Date(input.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const to = input.to ? new Date(input.to) : new Date();

      // Get all published targets in the org for this period
      const targets = await ctx.prisma.postTarget.findMany({
        where: {
          post: {
            organizationId: ctx.organizationId,
            publishedAt: { gte: from, lte: to },
          },
          status: "PUBLISHED",
        },
        select: { id: true },
      });

      const targetIds = targets.map((t: any) => t.id);

      if (targetIds.length === 0) {
        return {
          impressions: 0,
          clicks: 0,
          likes: 0,
          shares: 0,
          comments: 0,
          reach: 0,
          engagementRate: 0,
        };
      }

      // Get the latest analytics snapshot for each target
      const latestSnapshots: Array<{
        impressions: bigint;
        clicks: bigint;
        likes: bigint;
        shares: bigint;
        comments: bigint;
        reach: bigint;
        engagementRate: number;
      }> = await (ctx.prisma.$queryRawUnsafe as any)(
        `SELECT
          COALESCE(SUM(a.impressions), 0) as impressions,
          COALESCE(SUM(a.clicks), 0) as clicks,
          COALESCE(SUM(a.likes), 0) as likes,
          COALESCE(SUM(a.shares), 0) as shares,
          COALESCE(SUM(a.comments), 0) as comments,
          COALESCE(SUM(a.reach), 0) as reach,
          CASE WHEN SUM(a.impressions) > 0
            THEN CAST(SUM(a.likes + a.comments + a.shares) AS FLOAT) / SUM(a.impressions) * 100
            ELSE 0
          END as "engagementRate"
        FROM "AnalyticsSnapshot" a
        INNER JOIN (
          SELECT "postTargetId", MAX("snapshotAt") as max_snapshot
          FROM "AnalyticsSnapshot"
          WHERE "postTargetId" = ANY($1::text[])
          GROUP BY "postTargetId"
        ) latest ON a."postTargetId" = latest."postTargetId" AND a."snapshotAt" = latest.max_snapshot`,
        targetIds
      );

      const row = latestSnapshots[0];
      return {
        impressions: Number(row?.impressions ?? 0),
        clicks: Number(row?.clicks ?? 0),
        likes: Number(row?.likes ?? 0),
        shares: Number(row?.shares ?? 0),
        comments: Number(row?.comments ?? 0),
        reach: Number(row?.reach ?? 0),
        engagementRate: Number(row?.engagementRate ?? 0),
      };
    }),

  /** Dashboard stats: all-time counts for the org */
  dashboardStats: orgProcedure.query(async ({ ctx }) => {
    const [totalPosts, connectedChannels, publishedCount, aiGeneratedCount] =
      await Promise.all([
        ctx.prisma.post.count({
          where: { organizationId: ctx.organizationId },
        }),
        ctx.prisma.channel.count({
          where: { organizationId: ctx.organizationId, isActive: true },
        }),
        ctx.prisma.post.count({
          where: { organizationId: ctx.organizationId, status: "PUBLISHED" },
        }),
        ctx.prisma.post.count({
          where: {
            organizationId: ctx.organizationId,
            aiGenerated: true,
          },
        }),
      ]);

    return {
      totalPosts,
      connectedChannels,
      published: publishedCount,
      aiGenerated: aiGeneratedCount,
    };
  }),

  /** Platform-level breakdown of published targets */
  platformBreakdown: orgProcedure.query(async ({ ctx }) => {
    const targets = await ctx.prisma.postTarget.findMany({
      where: {
        post: { organizationId: ctx.organizationId },
        status: "PUBLISHED",
      },
      include: {
        channel: { select: { platform: true } },
      },
    });

    const breakdown: Record<string, number> = {};
    for (const t of targets) {
      const platform = t.channel.platform;
      breakdown[platform] = (breakdown[platform] ?? 0) + 1;
    }

    return Object.entries(breakdown)
      .map(([platform, count]) => ({ platform, count }))
      .sort((a, b) => b.count - a.count);
  }),

  /** Recent activity feed for the dashboard */
  recentActivity: orgProcedure
    .input(z.object({ limit: z.number().min(1).max(20).default(5) }))
    .query(async ({ ctx, input }) => {
      const recentTargets = await ctx.prisma.postTarget.findMany({
        where: {
          post: { organizationId: ctx.organizationId },
          status: { in: ["PUBLISHED", "FAILED"] },
        },
        include: {
          post: { select: { content: true } },
          channel: { select: { platform: true, name: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: input.limit,
      });

      return recentTargets.map((t: any) => ({
        id: t.id,
        postContent: t.post.content.slice(0, 80),
        platform: t.channel.platform,
        channelName: t.channel.name,
        status: t.status,
        publishedUrl: t.publishedUrl,
        errorMessage: t.errorMessage,
        timestamp: t.publishedAt ?? t.updatedAt,
      }));
    }),

  postMetrics: orgProcedure
    .input(z.object({ postTargetId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.analyticsSnapshot.findMany({
        where: { postTargetId: input.postTargetId },
        orderBy: { snapshotAt: "desc" },
        take: 30,
      });
    }),

  /** Daily post count over time */
  postsOverTime: orgProcedure
    .input(
      z.object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const from = input.from ? new Date(input.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const to = input.to ? new Date(input.to) : new Date();

      const posts = await ctx.prisma.post.findMany({
        where: {
          organizationId: ctx.organizationId,
          status: "PUBLISHED",
          publishedAt: { gte: from, lte: to },
        },
        select: { publishedAt: true },
        orderBy: { publishedAt: "asc" },
      });

      const grouped: Record<string, number> = {};
      for (const post of posts) {
        if (!post.publishedAt) continue;
        const day = post.publishedAt.toISOString().split("T")[0]!;
        grouped[day] = (grouped[day] ?? 0) + 1;
      }

      const result: { date: string; posts: number }[] = [];
      const current = new Date(from);
      while (current <= to) {
        const key = current.toISOString().split("T")[0]!;
        result.push({ date: key, posts: grouped[key] ?? 0 });
        current.setDate(current.getDate() + 1);
      }
      return result;
    }),

  /** Per-channel aggregated stats */
  perChannelStats: orgProcedure
    .input(
      z.object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const from = input.from ? new Date(input.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const to = input.to ? new Date(input.to) : new Date();

      const channels = await ctx.prisma.channel.findMany({
        where: { organizationId: ctx.organizationId, isActive: true },
      });

      const stats = await Promise.all(
        channels.map(async (channel) => {
          const postCount = await ctx.prisma.postTarget.count({
            where: {
              channelId: channel.id,
              status: "PUBLISHED",
              post: { publishedAt: { gte: from, lte: to } },
            },
          });

          const metrics: Array<{
            impressions: bigint;
            clicks: bigint;
            likes: bigint;
            shares: bigint;
            comments: bigint;
            reach: bigint;
          }> = await (ctx.prisma.$queryRawUnsafe as any)(
            `SELECT
              COALESCE(SUM(a.impressions), 0) as impressions,
              COALESCE(SUM(a.clicks), 0) as clicks,
              COALESCE(SUM(a.likes), 0) as likes,
              COALESCE(SUM(a.shares), 0) as shares,
              COALESCE(SUM(a.comments), 0) as comments,
              COALESCE(SUM(a.reach), 0) as reach
            FROM "AnalyticsSnapshot" a
            INNER JOIN (
              SELECT a2."postTargetId", MAX(a2."snapshotAt") as max_snap
              FROM "AnalyticsSnapshot" a2
              INNER JOIN "PostTarget" pt ON pt.id = a2."postTargetId"
              INNER JOIN "Post" p ON p.id = pt."postId"
              WHERE pt."channelId" = $1
                AND p."publishedAt" >= $2
                AND p."publishedAt" <= $3
              GROUP BY a2."postTargetId"
            ) latest ON a."postTargetId" = latest."postTargetId" AND a."snapshotAt" = latest.max_snap`,
            channel.id,
            from,
            to
          );

          const m = metrics[0];
          const impressions = Number(m?.impressions ?? 0);
          const likes = Number(m?.likes ?? 0);
          const comments = Number(m?.comments ?? 0);
          const shares = Number(m?.shares ?? 0);
          const engagementRate =
            impressions > 0 ? ((likes + comments + shares) / impressions) * 100 : 0;

          return {
            id: channel.id,
            name: channel.name,
            username: channel.username,
            avatar: channel.avatar,
            platform: channel.platform,
            postCount,
            impressions,
            clicks: Number(m?.clicks ?? 0),
            likes,
            shares,
            comments,
            reach: Number(m?.reach ?? 0),
            engagementRate,
          };
        })
      );

      return stats.sort((a, b) => b.postCount - a.postCount);
    }),

  /** On-demand: queue analytics sync for all published posts in this org */
  triggerSync: orgProcedure.mutation(async ({ ctx }) => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const publishedTargets = await ctx.prisma.postTarget.findMany({
      where: {
        status: "PUBLISHED",
        publishedId: { not: null },
        publishedAt: { gte: thirtyDaysAgo },
        channel: {
          organizationId: ctx.organizationId,
          isActive: true,
        },
      },
      select: {
        id: true,
        publishedId: true,
        channelId: true,
        channel: { select: { platform: true } },
      },
    });

    let queued = 0;
    for (const target of publishedTargets) {
      if (!target.publishedId) continue;
      await analyticsSyncQueue.add(
        `analytics-manual-${target.id}`,
        {
          postTargetId: target.id,
          platform: target.channel.platform,
          channelId: target.channelId,
          platformPostId: target.publishedId,
        },
        {
          jobId: `analytics-manual-${target.id}-${Date.now()}`,
          removeOnComplete: true,
          removeOnFail: 100,
        }
      );
      queued++;
    }

    return { queued };
  }),
});
