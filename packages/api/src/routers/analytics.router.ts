import { z } from "zod";
import { createRouter, orgProcedure } from "../trpc";
import { analyticsSyncQueue } from "@postautomation/queue";
import type { PrismaClient } from "@postautomation/db";
import {
  sumChannelRowsIntoGroups,
  type ChannelStatRow,
} from "../lib/group-stats";

/**
 * ONE org-scoped aggregate for per-channel metrics: latest snapshot per
 * published target (LEFT JOIN LATERAL … LIMIT 1), summed per channel.
 * Shared by perChannelStats and groupStats — replaces the old N+1 (2 queries
 * per channel, 220+ round-trips on a 110-channel org).
 *
 * Positional params only; organizationId is ALWAYS in the WHERE (IDOR history).
 * COALESCE(publishedAt, updatedAt) keeps PUBLISHED posts with a NULL
 * publishedAt from being silently dropped (audit fix 2026-06-06).
 */
async function fetchChannelStatRows(
  prisma: PrismaClient,
  organizationId: string,
  from: Date,
  to: Date
): Promise<ChannelStatRow[]> {
  const rows: Array<{
    channelId: string;
    posts: bigint;
    impressions: bigint;
    reach: bigint;
    likes: bigint;
    comments: bigint;
    shares: bigint;
    clicks: bigint;
  }> = await (prisma.$queryRawUnsafe as any)(
    `SELECT pt."channelId"                  AS "channelId",
            COUNT(DISTINCT p.id)            AS posts,
            COALESCE(SUM(s.impressions), 0) AS impressions,
            COALESCE(SUM(s.reach), 0)       AS reach,
            COALESCE(SUM(s.likes), 0)       AS likes,
            COALESCE(SUM(s.comments), 0)    AS comments,
            COALESCE(SUM(s.shares), 0)      AS shares,
            COALESCE(SUM(s.clicks), 0)      AS clicks
     FROM "PostTarget" pt
     INNER JOIN "Post" p ON p.id = pt."postId"
     INNER JOIN "Channel" c ON c.id = pt."channelId" AND c."isActive" = true
     LEFT JOIN LATERAL (
       SELECT s2.* FROM "AnalyticsSnapshot" s2
       WHERE s2."postTargetId" = pt.id
       ORDER BY s2."snapshotAt" DESC
       LIMIT 1
     ) s ON TRUE
     WHERE p."organizationId" = $1
       AND pt.status::text = 'PUBLISHED'
       AND COALESCE(p."publishedAt", p."updatedAt") BETWEEN $2 AND $3
     GROUP BY pt."channelId"`,
    organizationId,
    from,
    to
  );

  // Numeric SQL aggregates surface as BigInts — normalize for superjson/UI.
  return rows.map((r) => ({
    channelId: r.channelId,
    posts: Number(r.posts),
    impressions: Number(r.impressions),
    reach: Number(r.reach),
    likes: Number(r.likes),
    comments: Number(r.comments),
    shares: Number(r.shares),
    clicks: Number(r.clicks),
  }));
}

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
      // PUBLISHED targets counted org-wide at the target level (same population
      // convention as platformBreakdown, so the two cards on the page agree).
      // Date predicate: parent publishedAt in range, or (null publishedAt) the
      // target's own updatedAt — matching the `failed` predicate below.
      const published = await ctx.prisma.postTarget.count({
        where: {
          status: "PUBLISHED",
          post: { organizationId: ctx.organizationId },
          OR: [
            { post: { publishedAt: { gte: from, lte: to } } },
            { post: { publishedAt: null }, updatedAt: { gte: from, lte: to } },
          ],
        },
      });
      // FAILED targets are counted org-wide regardless of parent Post.status —
      // a post whose EVERY target failed never reaches Post.status=PUBLISHED,
      // so filtering to published posts silently undercounted failures
      // (accuracy fix 2026-07-17). The NULL-publishedAt branch keys on the
      // TARGET's own updatedAt (not the mutable parent Post.updatedAt) so a
      // later edit to an unpublished post can't re-date old failures into the
      // current window.
      const failed = await ctx.prisma.postTarget.count({
        where: {
          status: "FAILED",
          post: { organizationId: ctx.organizationId },
          OR: [
            { post: { publishedAt: { gte: from, lte: to } } },
            { post: { publishedAt: null }, updatedAt: { gte: from, lte: to } },
          ],
        },
      });

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

  /**
   * Platform-level breakdown of published targets. Honors the date picker
   * (accuracy fix 2026-07-17 — it used to be all-time while every sibling card
   * respected the selected range). Date predicate mirrors the rest of this
   * router: parent Post publishedAt in range, updatedAt fallback when NULL.
   */
  platformBreakdown: orgProcedure
    .input(
      z
        .object({
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
        })
        // The whole object is optional: this procedure had NO input before, so
        // documented external callers (openapi/generate-spec.ts) may still hit
        // it bare — they get the 30-day default instead of a zod reject.
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const from = input?.from ? new Date(input.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const to = input?.to ? new Date(input.to) : new Date();

      const targets = await ctx.prisma.postTarget.findMany({
        where: {
          post: {
            organizationId: ctx.organizationId,
            OR: [
              { publishedAt: { gte: from, lte: to } },
              { publishedAt: null, updatedAt: { gte: from, lte: to } },
            ],
          },
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
      // BUG-09: normalise the window to whole days. Previously `from`/`to`
      // carried a time-of-day (Date.now() - 30d … now), so the day-stepping
      // loop below could finish just before `to` and drop TODAY's column
      // (the tester saw the x-axis end before today). Anchor `from` to the
      // start of its day and `to` to the END of today so the range is
      // inclusive of the current day.
      const from = input.from ? new Date(input.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const to = input.to ? new Date(input.to) : new Date();
      // UTC, not server-local: analytics date ranges are UTC end-to-end (the
      // picker sends UTC midnights; the day loop below already steps in UTC).
      from.setUTCHours(0, 0, 0, 0);
      to.setUTCHours(23, 59, 59, 999);

      const posts = await ctx.prisma.post.findMany({
        where: {
          organizationId: ctx.organizationId,
          status: "PUBLISHED",
          // A PUBLISHED post should always have publishedAt; fall back to
          // updatedAt for older/lagged rows so they still appear on the chart.
          OR: [
            { publishedAt: { gte: from, lte: to } },
            { publishedAt: null, updatedAt: { gte: from, lte: to } },
          ],
        },
        select: { publishedAt: true, updatedAt: true },
        orderBy: { updatedAt: "asc" },
      });

      const grouped: Record<string, number> = {};
      for (const post of posts) {
        const when = post.publishedAt ?? post.updatedAt;
        if (!when) continue;
        const day = when.toISOString().split("T")[0]!;
        grouped[day] = (grouped[day] ?? 0) + 1;
      }

      const result: { date: string; posts: number }[] = [];
      // Iterate by calendar day at noon UTC to avoid DST/time-of-day drift,
      // up to and including today.
      const current = new Date(from);
      current.setUTCHours(12, 0, 0, 0);
      const end = new Date(to);
      while (current <= end) {
        const key = current.toISOString().split("T")[0]!;
        result.push({ date: key, posts: grouped[key] ?? 0 });
        current.setUTCDate(current.getUTCDate() + 1);
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

      // ONE aggregate query + one channel-meta query — was an N+1 (2 queries
      // per channel; 220+ round-trips on a 110-channel org). Channel meta is
      // merged in JS so the output shape is unchanged for the UI table.
      const [channels, statRows] = await Promise.all([
        ctx.prisma.channel.findMany({
          where: { organizationId: ctx.organizationId, isActive: true },
        }),
        fetchChannelStatRows(ctx.prisma, ctx.organizationId, from, to),
      ]);

      const rowByChannel = new Map(statRows.map((r) => [r.channelId, r]));

      const stats = channels.map((channel) => {
        const m = rowByChannel.get(channel.id);
        const impressions = m?.impressions ?? 0;
        const likes = m?.likes ?? 0;
        const comments = m?.comments ?? 0;
        const shares = m?.shares ?? 0;
        const engagementRate =
          impressions > 0 ? ((likes + comments + shares) / impressions) * 100 : 0;

        return {
          id: channel.id,
          name: channel.name,
          username: channel.username,
          avatar: channel.avatar,
          platform: channel.platform,
          postCount: m?.posts ?? 0,
          impressions,
          clicks: m?.clicks ?? 0,
          likes,
          shares,
          comments,
          reach: m?.reach ?? 0,
          engagementRate,
        };
      });

      return stats.sort((a, b) => b.postCount - a.postCount);
    }),

  /**
   * Group-wise ("campaign") analytics: the SAME per-channel aggregate as
   * perChannelStats, summed into ChannelGroups in JS (pure helper — see
   * packages/api/src/lib/group-stats.ts). Channels in multiple groups count in
   * each; channels in none land in an "Ungrouped" bucket. USER-role readable.
   */
  groupStats: orgProcedure
    .input(
      z.object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const from = input.from ? new Date(input.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const to = input.to ? new Date(input.to) : new Date();

      const [groups, statRows, ungroupedChannelCount] = await Promise.all([
        ctx.prisma.channelGroup.findMany({
          where: { organizationId: ctx.organizationId },
          select: {
            id: true,
            name: true,
            color: true,
            // Active members only — matches the active-only stat aggregate, the
            // Channel Performance table, and the Compose group quick-select.
            channels: { select: { id: true }, where: { isActive: true } },
          },
        }),
        fetchChannelStatRows(ctx.prisma, ctx.organizationId, from, to),
        // True count of active channels in NO group — drives the Ungrouped
        // bucket's Channels column (membership semantics, like the group rows).
        ctx.prisma.channel.count({
          where: {
            organizationId: ctx.organizationId,
            isActive: true,
            channelGroups: { none: {} },
          },
        }),
      ]);

      return {
        rows: sumChannelRowsIntoGroups(groups, statRows, ungroupedChannelCount),
        groupCount: groups.length,
      };
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

  /**
   * Insights → Reports: per-post × per-channel rows over a time window, in a
   * structured, extractable (CSV) shape. USER-role accessible (read-only).
   *
   * Window semantics (owner decision 2026-07-17 — the two modes select
   * DIFFERENT rows):
   *  - mode "current": every target PUBLISHED within the window, with its
   *    LATEST snapshot (the proven MAX(snapshotAt) pattern from perChannelStats).
   *  - mode "at_age": targets OLD ENOUGH to have reached the checkpoint —
   *    publishedAt <= now - window — with metrics pinned to the at-age
   *    checkpoint snapshot (metadata.windowTag written by the delayed jobs
   *    enqueued at publish — post-publish.worker.ts 4c). The checkpoint fires
   *    exactly one window-duration AFTER publish, so filtering to posts
   *    published WITHIN the window (like "current") can never match a tagged
   *    snapshot — that contradiction made at_age structurally empty forever
   *    (accuracy fix 2026-07-17). Checkpoints accrue for posts published after
   *    2026-07-17; older posts show NULL metrics (UI renders "—").
   *
   * Metric caveats (platform APIs, not bugs): "views" ride on impressions
   * (YouTube/Threads map views→impressions); Twitter metrics are 0 on the free
   * API tier; Instagram never exposes clicks/shares.
   */
  postReports: orgProcedure
    .input(
      z.object({
        window: z.enum(["24h", "7d", "15d", "30d"]),
        mode: z.enum(["current", "at_age"]).default("current"),
        limit: z.number().min(1).max(1000).default(500),
      })
    )
    .query(async ({ ctx, input }) => {
      const hours = { "24h": 24, "7d": 168, "15d": 360, "30d": 720 }[input.window];
      const boundary = new Date(Date.now() - hours * 3_600_000);

      // Row selector: "current" = published WITHIN the window; "at_age" =
      // published AT LEAST one window ago (old enough for the checkpoint to
      // have fired). Same boundary date, opposite comparison.
      const publishedAtFilter =
        input.mode === "current"
          ? `AND pt."publishedAt" >= $2`
          : `AND pt."publishedAt" <= $2`;

      // Snapshot selector: latest overall vs latest tagged at-age checkpoint.
      const snapshotFilter =
        input.mode === "current"
          ? ""
          : `AND s2.metadata->>'windowTag' = $3`;

      const params: any[] = [ctx.organizationId, boundary];
      if (input.mode === "at_age") params.push(input.window);
      params.push(input.limit);
      const limitIdx = params.length;

      const rows: Array<{
        targetId: string;
        postId: string;
        contentPreview: string;
        channelName: string;
        channelUsername: string | null;
        platform: string;
        publishedAt: Date | null;
        publishedUrl: string | null;
        impressions: number | null;
        clicks: number | null;
        likes: number | null;
        comments: number | null;
        shares: number | null;
        reach: number | null;
        engagementRate: number | null;
        snapshotAt: Date | null;
      }> = await (ctx.prisma.$queryRawUnsafe as any)(
        `SELECT pt.id              AS "targetId",
                p.id               AS "postId",
                LEFT(p.content, 140) AS "contentPreview",
                c.name             AS "channelName",
                c.username         AS "channelUsername",
                c.platform::text   AS "platform",
                pt."publishedAt",
                pt."publishedUrl",
                s.impressions, s.clicks, s.likes, s.comments, s.shares, s.reach,
                -- Recompute Eng.% from the raw counts: stored engagementRate is
                -- a 0–1 FRACTION for YT/IG/FB/Reddit but a PERCENT for
                -- Threads/Pinterest/DevTo (mixed units in historical rows).
                -- This matches how the Insights engagement procedure computes it.
                -- NULL means "no snapshot captured yet" (UI renders "—"); a
                -- captured snapshot with zero impressions is a real 0, NOT "—"
                -- (s."snapshotAt" is non-null exactly when the LATERAL matched).
                CASE
                  WHEN s.impressions > 0
                    THEN (s.likes + s.comments + s.shares)::float / s.impressions * 100
                  WHEN s."snapshotAt" IS NOT NULL THEN 0
                  ELSE NULL
                END AS "engagementRate",
                s."snapshotAt"
         FROM "PostTarget" pt
         INNER JOIN "Post" p    ON p.id = pt."postId"
         INNER JOIN "Channel" c ON c.id = pt."channelId"
         LEFT JOIN LATERAL (
           SELECT s2.* FROM "AnalyticsSnapshot" s2
           WHERE s2."postTargetId" = pt.id ${snapshotFilter}
           ORDER BY s2."snapshotAt" DESC
           LIMIT 1
         ) s ON TRUE
         WHERE p."organizationId" = $1
           AND pt.status::text = 'PUBLISHED'
           AND pt."publishedAt" IS NOT NULL
           ${publishedAtFilter}
         ORDER BY pt."publishedAt" DESC
         LIMIT $${limitIdx}`,
        ...params
      );

      return {
        // Numeric SQL aggregates can surface as bigints — normalize for superjson/UI.
        rows: rows.map((r) => ({
          ...r,
          impressions: r.impressions === null ? null : Number(r.impressions),
          clicks: r.clicks === null ? null : Number(r.clicks),
          likes: r.likes === null ? null : Number(r.likes),
          comments: r.comments === null ? null : Number(r.comments),
          shares: r.shares === null ? null : Number(r.shares),
          reach: r.reach === null ? null : Number(r.reach),
          engagementRate: r.engagementRate === null ? null : Number(r.engagementRate),
        })),
        window: input.window,
        mode: input.mode,
        generatedAt: new Date().toISOString(),
      };
    }),
});
