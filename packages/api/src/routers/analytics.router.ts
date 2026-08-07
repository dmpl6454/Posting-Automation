import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { analyticsSyncQueue, externalPostSyncQueue } from "@postautomation/queue";
import { groupChannelsIntoAccounts } from "../lib/sync-accounts";
import { EXTERNAL_POST_FLOOR } from "../lib/external-post-floor";
import type { PrismaClient } from "@postautomation/db";
import {
  sumChannelRowsIntoGroups,
  type ChannelStatRow,
} from "../lib/group-stats";
import { createRateLimitMiddleware } from "../middleware/rate-limit.middleware";
import { emailReportRateLimiter } from "../middleware/rate-limit";
import { sendEmail } from "../lib/email";
import { escapeHtml } from "../lib/sanitize";
import {
  platformMetricCapabilities,
  effectiveChannelUnavailable,
  reportableMetrics,
  requiresExplicitDeclaration,
} from "../lib/platform-metrics";
import { evaluateChannelInsightsStatus, summarizeChannelStatuses } from "../lib/insights-health";
import { toCsv } from "../lib/report-csv";
import { createAuditLog, AUDIT_ACTIONS } from "../lib/audit";

/**
 * Emailed reports go to an ARBITRARY recipient — rate-limited (5/hour/user)
 * and audit-logged so the SMTP account can't be turned into a relay.
 */
const emailReportRateLimited = orgProcedure.use(
  createRateLimitMiddleware(emailReportRateLimiter)
);

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
  // Per-metric availability as DECLARED by each capture. Mirrors
  // gatePostReportRow's rule, lifted to an aggregate:
  //   no capability claim        ⇒ NULL (unknown — consult the static map)
  //   key absent from the claim  ⇒ TRUE  (capture declared others, not this one)
  //   key present                ⇒ TRUE unless explicitly 'false'
  // BOOL_OR then answers "did ANY capture report this metric?".
  // Uses ->>'key' IS NULL rather than the jsonb `?` operator on purpose — `?`
  // reads as a placeholder to some drivers and would be fragile here.
  //
  // ⚠️ `has_meta` and `avail` are SEPARATE columns on purpose, preserving the original
  // three-way distinction exactly:
  //   has_meta = false                   ⇒ NULL  (the capture made no claim at all)
  //   has_meta, but this key absent      ⇒ TRUE  (it declared others, so this one worked)
  //   key present                        ⇒ TRUE unless explicitly 'false'
  // Collapsing them into "avail IS NULL ⇒ unknown" would silently change behavior for
  // snapshots that carry metadata WITHOUT a metricsAvailable claim (e.g. an at-age
  // capture stamped only with windowTag), flipping them from "available" to the static
  // platform map — which on Facebook means a real number turning into "—".
  //
  // Both branches of the union below project these two columns (from
  // AnalyticsSnapshot.metadata for app-published posts, ExternalPost."metricsAvailable"
  // for platform-native ones), so this one rule governs both populations.
  const availExpr = (key: string) =>
    `BOOL_OR(CASE WHEN NOT has_meta THEN NULL
                  WHEN (avail->>'${key}') IS NULL THEN TRUE
                  ELSE (avail->>'${key}') <> 'false' END)`;

  const rows: Array<{
    channelId: string;
    posts: bigint;
    impressions: bigint;
    reach: bigint;
    likes: bigint;
    comments: bigint;
    shares: bigint;
    clicks: bigint;
    hasSnapshot: boolean;
    impressionedImpressions: bigint;
    impressionedLikes: bigint;
    impressionedComments: bigint;
    impressionedShares: bigint;
    impressionedPosts: bigint;
    availImpressions: boolean | null;
    availReach: boolean | null;
    availLikes: boolean | null;
    availComments: boolean | null;
    availShares: boolean | null;
    availClicks: boolean | null;
    hasLegacySnapshot: boolean | null;
  }> = await (prisma.$queryRawUnsafe as any)(
    // Two populations, ONE aggregate:
    //   app_rows — posts published THROUGH PostAutomation (unchanged semantics)
    //   ext_rows — posts that exist on the platform but were NOT published by us
    //
    // ⚠️ ext_rows is filtered to `postTargetId IS NULL`, i.e. ONLY posts we did not
    // publish. Posts we did publish keep flowing through app_rows exactly as before, so
    // this change is purely ADDITIVE and can never double-count. If dedup ever
    // mis-classifies, it loses a row (conservative) rather than inflating a number.
    //
    // Both branches project the SAME normalized columns so the outer aggregate — and
    // therefore every honesty rule below it — is written once and applies to both.
    `WITH app_rows AS (
       SELECT pt."channelId"                       AS channel_id,
              'a:' || p.id                         AS post_key,
              COALESCE(s.impressions, 0)           AS impressions,
              COALESCE(s.reach, 0)                 AS reach,
              COALESCE(s.likes, 0)                 AS likes,
              COALESCE(s.comments, 0)              AS comments,
              COALESCE(s.shares, 0)                AS shares,
              COALESCE(s.clicks, 0)                AS clicks,
              (s.id IS NOT NULL)                   AS has_metrics,
              (s.metadata IS NOT NULL)             AS has_meta,
              s.metadata->'metricsAvailable'       AS avail,
              (s.id IS NOT NULL AND s.metadata IS NULL) AS is_legacy
       FROM "PostTarget" pt
       INNER JOIN "Post" p ON p.id = pt."postId"
       -- ⚠️ Deliberately NOT filtered on c."isActive" (owner decision 2026-08-06:
       -- "count all real history"). A post that WAS published and DID earn
       -- engagement is a historical fact; excluding it because the channel was
       -- later paused or disconnected understated every total. This is why
       -- disconnecting a channel used to make its history vanish from Insights.
       -- Rows carry their own status so the UI can badge Paused/Disconnected, and
       -- they age out naturally once outside the selected window.
       INNER JOIN "Channel" c ON c.id = pt."channelId"
       LEFT JOIN LATERAL (
         SELECT s2.* FROM "AnalyticsSnapshot" s2
         WHERE s2."postTargetId" = pt.id
         ORDER BY s2."snapshotAt" DESC
         LIMIT 1
       ) s ON TRUE
       WHERE p."organizationId" = $1
         AND pt.status::text = 'PUBLISHED'
         AND COALESCE(p."publishedAt", p."updatedAt") BETWEEN $2 AND $3
     ),
     ext_rows AS (
       SELECT ep."channelId"                       AS channel_id,
              'e:' || ep.id                        AS post_key,
              ep.impressions, ep.reach, ep.likes, ep.comments, ep.shares, ep.clicks,
              -- NULL metricsSyncedAt = listed but never measured ⇒ "—", never a fake 0.
              (ep."metricsSyncedAt" IS NOT NULL)    AS has_metrics,
              -- Both Meta providers always declare metricsAvailable, so a measured row
              -- without one made no claim ⇒ defer to the static platform map.
              (ep."metricsAvailable" IS NOT NULL)   AS has_meta,
              ep."metricsAvailable"                 AS avail,
              (ep."metricsSyncedAt" IS NOT NULL AND ep."metricsAvailable" IS NULL) AS is_legacy
       FROM "ExternalPost" ep
       -- organizationId is proven through the Channel join — the same IDOR-safe shape
       -- every other Insights query uses.
       INNER JOIN "Channel" c2 ON c2.id = ep."channelId"
       WHERE c2."organizationId" = $1
         AND ep."postTargetId" IS NULL
         AND ep."publishedAt" BETWEEN $2 AND $3
     ),
     all_rows AS (
       SELECT * FROM app_rows
       UNION ALL
       SELECT * FROM ext_rows
     )
     SELECT channel_id                       AS "channelId",
            COUNT(DISTINCT post_key)         AS posts,
            COALESCE(SUM(impressions), 0)    AS impressions,
            COALESCE(SUM(reach), 0)          AS reach,
            COALESCE(SUM(likes), 0)          AS likes,
            COALESCE(SUM(comments), 0)       AS comments,
            COALESCE(SUM(shares), 0)         AS shares,
            COALESCE(SUM(clicks), 0)         AS clicks,
            -- Impressioned-only sums: the ONLY honest basis for an engagement
            -- rate. Pooling engagement from ALL posts over a denominator built
            -- from only the impressioned ones produced 1400% on prod (7 posts'
            -- reactions ÷ one 1-view video). See engagement-rate.ts for the rule.
            -- Unaffected by the union: an unmeasured external post has impressions
            -- 0, so it contributes to NEITHER side — exactly the intended rule.
            COALESCE(SUM(impressions) FILTER (WHERE impressions > 0), 0) AS "impressionedImpressions",
            COALESCE(SUM(likes)       FILTER (WHERE impressions > 0), 0) AS "impressionedLikes",
            COALESCE(SUM(comments)    FILTER (WHERE impressions > 0), 0) AS "impressionedComments",
            COALESCE(SUM(shares)      FILTER (WHERE impressions > 0), 0) AS "impressionedShares",
            COUNT(*) FILTER (WHERE impressions > 0)                      AS "impressionedPosts",
            -- true when at least one row on this channel has captured metrics;
            -- drives the UI's "—" (no data yet) vs "0" (real zero).
            BOOL_OR(has_metrics)             AS "hasSnapshot",
            ${availExpr("impressions")}      AS "availImpressions",
            ${availExpr("reach")}            AS "availReach",
            ${availExpr("likes")}            AS "availLikes",
            ${availExpr("comments")}         AS "availComments",
            ${availExpr("shares")}           AS "availShares",
            ${availExpr("clicks")}           AS "availClicks",
            -- a capture that makes no capability claim ⇒ the static platform map
            -- must still apply for it.
            BOOL_OR(is_legacy)               AS "hasLegacySnapshot"
     FROM all_rows
     GROUP BY channel_id`,
    organizationId,
    from,
    to
  );

  // Numeric SQL aggregates surface as BigInts — normalize for superjson/UI.
  // BOOL_OR over zero rows (or all-NULL) yields NULL: preserve that as undefined
  // ("unknown"), which is distinct from false ("every capture said unavailable").
  const tri = (v: boolean | null): boolean | undefined => (v === null ? undefined : Boolean(v));
  return rows.map((r) => ({
    channelId: r.channelId,
    posts: Number(r.posts),
    impressions: Number(r.impressions),
    reach: Number(r.reach),
    likes: Number(r.likes),
    comments: Number(r.comments),
    shares: Number(r.shares),
    clicks: Number(r.clicks),
    hasSnapshot: Boolean(r.hasSnapshot),
    impressionedImpressions: Number(r.impressionedImpressions),
    impressionedLikes: Number(r.impressionedLikes),
    impressionedComments: Number(r.impressionedComments),
    impressionedShares: Number(r.impressionedShares),
    impressionedPosts: Number(r.impressionedPosts),
    declaredAvailable: {
      impressions: tri(r.availImpressions),
      reach: tri(r.availReach),
      likes: tri(r.availLikes),
      comments: tri(r.availComments),
      shares: tri(r.availShares),
      clicks: tri(r.availClicks),
    },
    hasLegacySnapshot: Boolean(r.hasLegacySnapshot),
  }));
}

type ReportWindow = "24h" | "7d" | "15d" | "30d";
type ReportMode = "current" | "at_age";

export interface PostReportRow {
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
  /**
   * Saves/bookmarks — a distinct action, not a like. Captured into snapshot
   * metadata by the providers (IG `saved`, unlocked for external users by the
   * `instagram_manage_insights` approval); projected here by gatePostReportRow so
   * the table and CSV can render it. null ⇒ this platform/post reports no saves.
   */
  saved?: number | null;
  /** IG Reels mean watch time in milliseconds; null for everything else. */
  avgWatchTimeMs?: number | null;
  /**
   * The captured snapshot's own honesty metadata (AnalyticsSnapshot.metadata,
   * written by apps/worker/src/lib/snapshot-metadata.ts). Optional: legacy rows
   * and non-snapshot rows have none. See gatePostReportRow for why it wins over
   * the static per-platform map.
   */
  snapshotMetadata?: {
    metricsAvailable?: Record<string, boolean>;
    saved?: number;
    avgWatchTimeMs?: number;
  } | null;
  /**
   * true ⇒ this post exists on the platform but was NOT published through
   * PostAutomation (ingested by the external-post sync). Lets the UI label it honestly
   * instead of implying we sent it. Absent on legacy callers ⇒ treated as false.
   */
  isExternal?: boolean;
}

/**
 * Per-row honesty gate for Reports rows. Applies the SAME per-platform capability
 * rule as the Channel Performance table (metricCellValue → platformMetricCapabilities):
 * a metric the platform NEVER reports (e.g. FB impressions/reach — Meta deleted
 * those metrics) must render "—", not a fake 0. The provider stores 0 for these,
 * so without this Reports would show "0" while Channel Performance shows "—" for
 * the same data. Coercing to null makes the table (num()), the CSV export, and the
 * emailed report all honest. Also re-Numbers SQL bigints for superjson/UI.
 * Pure + testable (report-metric-gate.test.ts).
 *
 * ⚠️ PER-SNAPSHOT metadata OVERRIDES the static platform map (fixed 2026-07-27).
 * The static map is a platform-wide constant, but capability varies PER POST on
 * Facebook: a FEED post genuinely has no impressions/reach (Meta deleted those
 * insight metrics), while a VIDEO/REEL post returns REAL view counts through
 * `video_insights` (facebook.provider getFacebookVideoAnalytics maps
 * total_video_views onto the impressions slot) or the reel-scraper fallback —
 * and those paths deliberately do NOT declare impressions unavailable.
 * Marking FACEBOOK impressions+reach unavailable in the static map alone (PR #148)
 * therefore hid real, successfully-captured FB video views behind "—" in Reports,
 * CSV export and the emailed report. The provider already records the truth per
 * capture in AnalyticsSnapshot.metadata.metricsAvailable — which, until now, NO
 * read path consumed. Precedence: explicit `false` ⇒ "—"; metadata present and
 * the key not false ⇒ trust the captured value; no metadata (legacy rows) ⇒ fall
 * back to the static map, byte-identical to previous behavior.
 */
export function gatePostReportRow(r: PostReportRow): PostReportRow {
  const caps = platformMetricCapabilities(r.platform);
  const unavail = new Set(caps.unavailable);
  // Reach that is not a distinct metric (aliased from impressions) is also "—".
  const reachUnavailable = unavail.has("reach") || caps.reachIsDistinct === false;
  const declared = r.snapshotMetadata?.metricsAvailable;
  const hasDeclared = declared != null && typeof declared === "object";
  const gate = (
    key: "impressions" | "reach" | "likes" | "comments" | "shares" | "clicks",
    v: number | null
  ): number | null => {
    if (v === null || v === undefined) return null;
    if (hasDeclared && key in declared!) {
      // The capture itself told us whether this metric was reported.
      return declared![key] === false ? null : Number(v);
    }
    // ⚠️ NARROW EXCEPTION — a metric with an INDEPENDENT failure mode cannot inherit
    // "available" from its siblings.
    //
    // The general rule below ("this capture declared other keys, so an omitted one
    // worked") holds when every metric came from the same Graph call. On FACEBOOK it
    // does NOT: `clicks`/`likes` come from the post-INSIGHTS edge while `shares` comes
    // from the post-FIELDS edge (which additionally needs pages_read_user_content). A
    // capture could therefore succeed on insights — declaring clicks:true, likes:true —
    // while the fields call silently failed, leaving `shares` omitted and stored as 0.
    // The generic rule then published that 0 as a confident "0 shares".
    //
    // Measured on prod 2026-08-07: 12 FACEBOOK snapshots (2026-08-02 → 2026-08-07) have
    // the `shares` key omitted AND shares = 0 — users reported exactly this as "shares
    // are not visible / not working". Graph also OMITS the `shares` field entirely for a
    // post with genuinely zero shares, so "0 shares" and "we could not read shares" are
    // indistinguishable in storage; the only honest answer for a legacy row is "—".
    //
    // Captures written after the provider fix always declare `shares` explicitly, so
    // this branch only ever applies to pre-fix rows and self-heals on the next capture.
    if (hasDeclared && requiresExplicitDeclaration(r.platform, key)) return null;
    if (hasDeclared) return Number(v); // capture declared others, not this one ⇒ available
    if (key === "reach" ? reachUnavailable : unavail.has(key)) return null;
    return Number(v);
  };
  // Saves and Reels watch time live in the capture's metadata rather than in a
  // dedicated column (AnalyticsSnapshot has a fixed metric schema). Project them
  // onto the row so the table/CSV/email can render them without each consumer
  // re-parsing the JSON. Absent ⇒ null ⇒ "—", never a fake 0.
  const md = r.snapshotMetadata;
  const savedRaw = md && typeof md === "object" ? md.saved : undefined;
  const watchRaw = md && typeof md === "object" ? md.avgWatchTimeMs : undefined;
  const gatedImpressions = gate("impressions", r.impressions);
  return {
    ...r,
    impressions: gatedImpressions,
    clicks: gate("clicks", r.clicks),
    likes: gate("likes", r.likes),
    comments: gate("comments", r.comments),
    shares: gate("shares", r.shares),
    reach: gate("reach", r.reach),
    // Engagement rate IS engagement ÷ impressions, so it can only be as honest
    // as its denominator. When impressions render "—" (Meta deleted the FB Page-
    // post metric; or the capture was permission-blocked), a rate computed from
    // that hidden number is meaningless — and "0.00%" actively misreads as "no
    // engagement" when the truth is "not reported". Show "—" instead.
    engagementRate:
      gatedImpressions === null || r.engagementRate === null ? null : Number(r.engagementRate),
    saved: typeof savedRaw === "number" ? savedRaw : null,
    avgWatchTimeMs: typeof watchRaw === "number" ? watchRaw : null,
  };
}

/**
 * Shared row-builder for Insights → Reports (postReports query + emailReport
 * mutation). Extracted VERBATIM from postReports 2026-07-18 — the SQL, window
 * semantics, and normalization are byte-identical to the pre-extraction query.
 * organizationId is ALWAYS in the WHERE (IDOR history — keep it).
 * Post-SQL rows pass through gatePostReportRow for per-platform honesty.
 */
async function fetchPostReportRows(
  prisma: PrismaClient,
  organizationId: string,
  window: ReportWindow,
  mode: ReportMode,
  limit: number
): Promise<PostReportRow[]> {
  const hours = { "24h": 24, "7d": 168, "15d": 360, "30d": 720 }[window];
  const boundary = new Date(Date.now() - hours * 3_600_000);

  // Row selector: "current" = published WITHIN the window; "at_age" =
  // published AT LEAST one window ago (old enough for the checkpoint to
  // have fired). Same boundary date, opposite comparison.
  const publishedAtFilter =
    mode === "current"
      ? `AND pt."publishedAt" >= $2`
      : `AND pt."publishedAt" <= $2`;

  // Snapshot selector: latest overall vs latest tagged at-age checkpoint.
  const snapshotFilter =
    mode === "current"
      ? ""
      : `AND s2.metadata->>'windowTag' = $3`;

  const params: any[] = [organizationId, boundary];
  if (mode === "at_age") params.push(window);
  params.push(limit);
  const limitIdx = params.length;

  // Platform-native posts (not published through us) are unioned in for "current" mode.
  // ⚠️ NOT for "at_age": those rows are pinned to at-age CHECKPOINT snapshots that only
  // exist for posts we published (the delayed jobs are enqueued at publish time), so an
  // external post can never have one. Including them would render a table of "—" and
  // misrepresent at-age coverage.
  const externalUnion =
    mode === "current"
      ? `
     UNION ALL
     SELECT ep.id             AS "targetId",
            ep.id             AS "postId",
            LEFT(COALESCE(ep.message, ''), 140) AS "contentPreview",
            c2.name           AS "channelName",
            c2.username       AS "channelUsername",
            c2.platform::text AS "platform",
            ep."publishedAt",
            ep.permalink      AS "publishedUrl",
            ep.impressions, ep.clicks, ep.likes, ep.comments, ep.shares, ep.reach,
            CASE
              WHEN ep.impressions > 0
                THEN (ep.likes + ep.comments + ep.shares)::float / ep.impressions * 100
              WHEN ep."metricsSyncedAt" IS NOT NULL THEN 0
              ELSE NULL
            END AS "engagementRate",
            ep."metricsSyncedAt" AS "snapshotAt",
            -- Shape the honesty metadata like a snapshot's so gatePostReportRow needs
            -- no special case: it reads metadata.metricsAvailable either way.
            CASE WHEN ep."metricsAvailable" IS NULL THEN NULL
                 ELSE jsonb_build_object('metricsAvailable', ep."metricsAvailable") END AS "snapshotMetadata",
            TRUE AS "isExternal"
     FROM "ExternalPost" ep
     INNER JOIN "Channel" c2 ON c2.id = ep."channelId"
     WHERE c2."organizationId" = $1
       AND ep."postTargetId" IS NULL
       AND ep."publishedAt" >= $2`
      : "";

  const rows: PostReportRow[] = await (prisma.$queryRawUnsafe as any)(
    `SELECT * FROM (
     SELECT pt.id              AS "targetId",
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
            s."snapshotAt",
            -- Per-capture honesty metadata (metricsAvailable) — gatePostReportRow
            -- prefers this over the static per-platform map so a real captured
            -- value (e.g. FB video views) is never hidden as "—".
            s.metadata        AS "snapshotMetadata",
            FALSE AS "isExternal"
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
     ${externalUnion}
     ) combined
     ORDER BY "publishedAt" DESC
     LIMIT $${limitIdx}`,
    ...params
  );

  // Numeric SQL aggregates can surface as bigints — normalize for superjson/UI,
  // then apply the per-platform honesty gate (see gatePostReportRow).
  return rows.map(gatePostReportRow);
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

      const totalPosts = await ctx.prisma.post.count({
        where: {
          organizationId: ctx.organizationId,
          status: "PUBLISHED",
          publishedAt: { gte: from, lte: to },
        },
      });

      // The window predicate shared by totalTargets/published/failed so all
      // three are the SAME target-level population. Using it for BOTH the
      // denominator (totalTargets, all statuses) and the numerator (published,
      // status=PUBLISHED) guarantees published <= totalTargets — the old
      // totalTargets counted only targets of publishedAt-in-range posts and
      // EXCLUDED the null-publishedAt OR-branch that `published` includes, so a
      // mixed-outcome publish (Post.publishedAt still null while some targets
      // are already PUBLISHED) could render "published > totalTargets".
      const windowTargetWhere = {
        post: { organizationId: ctx.organizationId },
        OR: [
          { post: { publishedAt: { gte: from, lte: to } } },
          { post: { publishedAt: null }, updatedAt: { gte: from, lte: to } },
        ],
      };

      const totalTargets = await ctx.prisma.postTarget.count({ where: windowTargetWhere });
      const published = await ctx.prisma.postTarget.count({
        where: { ...windowTargetWhere, status: "PUBLISHED" },
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

      // Population MUST match fetchChannelStatRows (Channel Performance / Group
      // Performance), or the headline tiles silently disagree with the table
      // right below them.
      //
      // ⚠️ This used to filter `channel: { isActive: true }`, with a comment
      // claiming it matched perChannelStats' "INNER JOIN Channel isActive" —
      // but that join filter was REMOVED by the 2026-08-06 soft-delete work
      // (owner decision: "count all real history", since a post that WAS
      // published and DID earn engagement is a historical fact). The comment
      // outlived the code it described. Left as-is, pausing or disconnecting a
      // channel with in-window history would drop its engagement from the
      // headline Engagement Breakdown while the Channel Performance table below
      // still counted it. Measured on prod 2026-08-06 the two populations were
      // still identical (96 = 96, zero inactive channels with in-window
      // history), so this is a latent divergence being closed before it bites —
      // not a currently-visible wrong number.
      //
      // The date predicate also gains the COALESCE(publishedAt, updatedAt)
      // fallback used by every sibling query, so a PUBLISHED post with a NULL
      // publishedAt isn't silently dropped from the headline only.
      // ⚠️ Reuses the SAME aggregate as perChannelStats / groupStats.
      //
      // It previously ran its own bespoke SQL over AnalyticsSnapshot, which meant the
      // headline tiles and the Channel Performance table below them were computed by two
      // independent code paths that could (and did) drift apart. Sharing
      // fetchChannelStatRows makes them agree BY CONSTRUCTION, and is also what brings
      // platform-native posts into the headline — the union lives in one place.
      const statRows = await fetchChannelStatRows(ctx.prisma, ctx.organizationId, from, to);

      // Which metrics ANY connected platform can ever report. Lets the UI drop
      // dead tiles/cards entirely instead of showing a confident "0" for a
      // metric that is structurally impossible — e.g. "Total Reach: 0" on an
      // org with only Facebook channels, where Meta deleted the reach metric.
      // Includes paused/disconnected channels: their history still counts toward
      // the totals above (soft-delete decision 2026-08-06), so a metric only
      // THEY can report must keep its tile rather than having the tile dropped
      // while its number is still being summed into the totals.
      const orgChannels = await ctx.prisma.channel.findMany({
        where: { organizationId: ctx.organizationId },
        select: { platform: true },
      });
      const reportable = reportableMetrics(orgChannels.map((c) => c.platform as string));

      const sum = (pick: (r: (typeof statRows)[number]) => number) =>
        statRows.reduce((n, r) => n + pick(r), 0);

      // Engagement rate pools ONLY over rows that reported impressions, on BOTH sides of
      // the ratio. Violating this produced 1400% on prod (a channel's whole reaction
      // count divided by one video's view count). The impressioned* sums come straight
      // from the shared aggregate, so the rule holds across app-published AND
      // platform-native posts without being restated here.
      const impDen = sum((r) => r.impressionedImpressions ?? 0);
      const impNum =
        sum((r) => r.impressionedLikes ?? 0) +
        sum((r) => r.impressionedComments ?? 0) +
        sum((r) => r.impressionedShares ?? 0);

      return {
        impressions: sum((r) => r.impressions),
        clicks: sum((r) => r.clicks),
        likes: sum((r) => r.likes),
        shares: sum((r) => r.shares),
        comments: sum((r) => r.comments),
        reach: sum((r) => r.reach),
        engagementRate: impDen > 0 ? (impNum / impDen) * 100 : 0,
        reportableMetrics: reportable,
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
      // IDOR guard (2026-07-27): orgProcedure proves the CALLER belongs to the
      // acting org, but said nothing about the supplied postTargetId — any member
      // could read another org's snapshot history (impressions/likes/comments/
      // reach) by passing its target id.
      // NOTE: AnalyticsSnapshot has NO Prisma relation to PostTarget (bare
      // `postTargetId` column, see schema.prisma) — a nested `postTarget: {...}`
      // filter does not exist here. Ownership must be proven with a separate
      // org-scoped lookup on the target's parent post.
      const owned = await ctx.prisma.postTarget.findFirst({
        where: { id: input.postTargetId, post: { organizationId: ctx.organizationId } },
        select: { id: true },
      });
      if (!owned) return [];

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
        // Live channels PLUS any channel that has published history in the window
        // (owner decision 2026-08-06: count all real history). Disconnected and
        // paused channels are included so their genuine engagement still counts;
        // each row carries its status so the UI can badge it.
        ctx.prisma.channel.findMany({
          where: { organizationId: ctx.organizationId },
        }),
        fetchChannelStatRows(ctx.prisma, ctx.organizationId, from, to),
      ]);

      const rowByChannel = new Map(statRows.map((r) => [r.channelId, r]));

      const stats = channels
        // Keep every live channel, plus inactive/disconnected ones that actually
        // have activity in-window. Without the second clause, disconnecting a
        // channel would still erase its history from this table; without the
        // first, a freshly connected channel wouldn't appear until it posted.
        .filter((channel) => channel.isActive || rowByChannel.has(channel.id))
        .map((channel) => {
        const m = rowByChannel.get(channel.id);
        const impressions = m?.impressions ?? 0;
        const likes = m?.likes ?? 0;
        const comments = m?.comments ?? 0;
        const shares = m?.shares ?? 0;
        // Rate pools ONLY over posts that reported impressions, so a channel's
        // whole reaction count can't be divided by one video's view count (that
        // produced 1400% on prod). Mirrors engagement-rate.ts.
        const impDen = m?.impressionedImpressions ?? 0;
        const impNum =
          (m?.impressionedLikes ?? 0) + (m?.impressionedComments ?? 0) + (m?.impressionedShares ?? 0);
        const engagementRate = impDen > 0 ? (impNum / impDen) * 100 : 0;
        const caps = platformMetricCapabilities(channel.platform);
        // Per-capture capability OVERRIDES the platform-wide static map, so real
        // FB video views aren't hidden behind "—" here while Reports shows them.
        const unavailable = effectiveChannelUnavailable(
          channel.platform,
          m?.declaredAvailable,
          m?.hasLegacySnapshot
        );

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
          /**
           * How narrow the rate's base is. A rate computed from ONE video must
           * not read as the channel's overall rate — on Facebook that is the
           * normal case, since only video posts carry an impression figure. The
           * UI renders "7.02% (1 of 10 posts)" and shows "—" when the base is 0.
           */
          engagementRateBasis: {
            impressionedPosts: m?.impressionedPosts ?? 0,
            totalPosts: m?.posts ?? 0,
          },
          /** Lifecycle status so the table can badge history from dead channels. */
          channelStatus: channel.disconnectedAt
            ? ("disconnected" as const)
            : channel.isActive
              ? ("connected" as const)
              : ("paused" as const),
          // Honesty metadata for the UI (— vs 0, honest labels, hide dup reach):
          hasSnapshot: m?.hasSnapshot ?? false,
          likeKind: caps.likeKind,
          // Keep reach visible when a capture actually reported it, even if the
          // platform's static default treats reach as an impressions alias.
          reachIsDistinct: unavailable.includes("reach") ? caps.reachIsDistinct : true,
          unavailable,
          // "Reconnect to restore Insights" signal, written by the sync worker
          // from the Graph errors it already sees (channel-insights-health.ts).
          insightsHealth: evaluateChannelInsightsStatus(channel.metadata),
        };
      });

      return stats.sort((a, b) => b.postCount - a.postCount);
    }),

  /**
   * Which channels can't serve Insights until their owner reconnects them.
   *
   * Drives the Insights banner. A pure DB read of the verdict the analytics-sync
   * worker already wrote (channel-insights-health.ts) — deliberately NOT a live
   * `debug_token` sweep: that would be an N+1 over ~1300 channels and a batched
   * version exhausts Meta's app-level quota (verified — a 1328-channel audit hit
   * `#4 Application request limit reached` partway through).
   *
   * Reports ONLY channels carrying an explicit `needs_reconnect` verdict, so a
   * channel with genuinely zero engagement is never mislabeled as broken.
   * orgProcedure — USER-role readable, like the rest of Insights.
   */
  insightsHealth: orgProcedure.query(async ({ ctx }) => {
    const channels = await ctx.prisma.channel.findMany({
      where: { organizationId: ctx.organizationId, isActive: true },
      select: { id: true, name: true, platform: true, metadata: true },
    });
    // Covers BOTH failure modes: broken now (dead token / missing scope) and
    // about to lapse (Meta's 90-day data-access window, which nothing monitored
    // and which a background refresh provably cannot extend).
    const summary = summarizeChannelStatuses(channels);
    return {
      ...summary,
      // Cap the enumerated list so an org with hundreds of stale channels can't
      // bloat the payload; the counts stay exact for the banner copy.
      channels: summary.channels.slice(0, 50),
      totalActiveChannels: channels.length,
    };
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

      const [groups, statRows, ungroupedChannelCount, channelPlatforms] = await Promise.all([
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
        // Platform per channel, so each stat row can carry the SAME effective
        // capability list the Channel Performance table uses. Without it,
        // Group Performance rendered a raw sum with no honesty gate — showing
        // "Reach 0" for an FB-only group whose channels all report reach as
        // unavailable, one card below the table that correctly showed "—".
        ctx.prisma.channel.findMany({
          where: { organizationId: ctx.organizationId },
          select: { id: true, platform: true },
        }),
      ]);

      const platformById = new Map(channelPlatforms.map((c) => [c.id, c.platform as string]));
      const rowsWithCaps = statRows.map((r) => ({
        ...r,
        unavailable: effectiveChannelUnavailable(
          platformById.get(r.channelId) ?? "",
          r.declaredAvailable,
          r.hasLegacySnapshot
        ),
      }));

      return {
        rows: sumChannelRowsIntoGroups(groups, rowsWithCaps, ungroupedChannelCount),
        groupCount: groups.length,
      };
    }),

  /** On-demand: queue analytics sync for all published posts in this org */
  triggerSync: orgProcedure
    .input(
      z
        .object({
          // Sync horizon in days. Default 30 = the pre-2026-07-18 hardcoded
          // bound (byte-identical default path); callers may pass up to 90 to
          // refresh long-tail posts on demand.
          days: z.number().int().min(1).max(90).default(30),
        })
        // Whole object optional: existing callers invoke mutate() with no input.
        .optional()
    )
    .mutation(async ({ ctx, input }) => {
    const since = new Date(Date.now() - (input?.days ?? 30) * 24 * 60 * 60 * 1000);

    const publishedTargets = await ctx.prisma.postTarget.findMany({
      where: {
        status: "PUBLISHED",
        publishedId: { not: null },
        publishedAt: { gte: since },
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

    // ⚠️ Bucket the jobId to a 2-MINUTE window instead of Date.now().
    //
    // The id used to be `analytics-manual-{targetId}-{Date.now()}`, which is UNIQUE on
    // every click — so BullMQ's dedup could never fire and N people (or N impatient
    // clicks) enqueued N copies of the same work, each burning Meta quota to fetch
    // identical numbers. Bucketing makes concurrent clicks collapse onto ONE job per
    // target while still allowing a genuine re-sync a couple of minutes later.
    // `removeOnComplete: true` would otherwise let a finished job's id be re-added
    // immediately; the bucket is what actually holds the dedup window open.
    const bucket = Math.floor(Date.now() / (2 * 60 * 1000));

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
          // BullMQ only permits ':' in a custom jobId with EXACTLY three
          // colon-separated segments — keep this shape.
          jobId: `syncnow:${target.id}:${bucket}`,
          removeOnComplete: true,
          removeOnFail: 100,
        }
      );
      queued++;
    }

    // Sync Now must ALSO refresh posts made directly on the platform. Without this it
    // only re-read app-published posts, so a user clicking it saw their directly-posted
    // content stay stale and reasonably concluded the button was broken.
    // Same account-level keying as the cron: one job per DISTINCT platformId, fanned out
    // to every channel row for it — so this costs 1 Graph call per account, not per row.
    const metaChannels = await ctx.prisma.channel.findMany({
      where: {
        organizationId: ctx.organizationId,
        isActive: true,
        disconnectedAt: null,
        platform: { in: ["FACEBOOK", "INSTAGRAM"] },
      },
      select: {
        id: true,
        organizationId: true,
        platform: true,
        platformId: true,
        metadata: true,
        updatedAt: true,
      },
    });

    let accountsQueued = 0;
    if (metaChannels.length > 0) {
      const accounts = groupChannelsIntoAccounts(
        metaChannels.map((c) => ({
          id: c.id,
          platform: String(c.platform),
          platformId: c.platformId,
          metadata: c.metadata,
          updatedAt: c.updatedAt,
        })),
        new Date()
      );
      for (const account of accounts) {
        await externalPostSyncQueue.add(
          `extsync-manual-${account.platform}-${account.platformId}`,
          {
            platform: account.platform,
            platformId: account.platformId,
            candidateChannelIds: account.candidateChannelIds,
            targetChannelIds: account.targetChannelIds,
            since: EXTERNAL_POST_FLOOR.toISOString(),
          },
          {
            // Same 2-minute dedup bucket, so simultaneous clicks collapse to one job.
            jobId: `extsyncnow:${account.platform}-${account.platformId}:${bucket}`,
            removeOnComplete: true,
            removeOnFail: 100,
          }
        );
        accountsQueued++;
      }
    }

    // `queued` keeps its original meaning (app-published targets) so the existing
    // "Nothing to sync" UI check is unchanged; accounts are reported alongside.
    return { queued, accountsQueued };
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
        // 1001 so the export can fetch EXPORT_LIMIT(1000)+1 to detect truncation
        // (distinguish "exactly 1000, complete" from ">1000, truncated").
        limit: z.number().min(1).max(1001).default(500),
      })
    )
    .query(async ({ ctx, input }) => {
      const rows = await fetchPostReportRows(
        ctx.prisma,
        ctx.organizationId,
        input.window,
        input.mode,
        input.limit
      );

      return {
        rows,
        window: input.window,
        mode: input.mode,
        generatedAt: new Date().toISOString(),
        // Columns worth rendering at all: derived from the platforms actually
        // present in these rows (plus any per-capture override), so a metric no
        // platform here can EVER report is dropped instead of showing a column
        // of "—". Computed from capability, not from "all values are null" —
        // the latter also means "not synced yet".
        reportableMetrics: reportableMetrics(
          rows.map((r) => r.platform),
          rows.map((r) => r.snapshotMetadata?.metricsAvailable as any)
        ),
      };
    }),

  /**
   * Email the current filtered report (same rows as postReports) as a CSV
   * attachment to an arbitrary address. Recipient is UNTRUSTED input: the
   * mutation is rate-limited (5/hour/user), audit-logged, and the address is
   * never interpolated into HTML (it only feeds nodemailer's `to:` header —
   * zod's .email() rejects header-injection newlines).
   */
  emailReport: emailReportRateLimited
    .input(
      z.object({
        to: z.string().email(),
        window: z.enum(["24h", "7d", "15d", "30d"]),
        mode: z.enum(["current", "at_age"]).default("current"),
        limit: z.number().min(1).max(1000).default(1000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await fetchPostReportRows(
        ctx.prisma,
        ctx.organizationId,
        input.window,
        input.mode,
        input.limit
      );

      if (rows.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No report rows for this window — nothing to email.",
        });
      }

      // Same columns as the Reports page CSV export (ReportsTab.tsx).
      const csv = toCsv(
        [
          "Post",
          "Channel",
          "Handle",
          "Platform",
          "Published At (UTC)",
          "Post URL",
          "Views/Impressions",
          "Clicks",
          "Likes",
          "Comments",
          "Shares",
          "Reach",
          "Saves",
          "Engagement %",
          "Metric captured at (UTC)",
        ],
        rows.map((r) => [
          r.contentPreview,
          r.channelName,
          r.channelUsername ?? "",
          r.platform,
          r.publishedAt ? new Date(r.publishedAt).toISOString() : "",
          r.publishedUrl ?? "",
          r.impressions,
          r.clicks,
          r.likes,
          r.comments,
          r.shares,
          r.reach,
          r.saved,
          r.engagementRate,
          r.snapshotAt ? new Date(r.snapshotAt).toISOString() : "",
        ])
      );

      const day = new Date().toISOString().slice(0, 10);
      const truncated = rows.length >= input.limit;
      const filename = `postautomation-report-${input.window}-${input.mode}-${day}${truncated ? "-truncated" : ""}.csv`;
      const modeLabel = input.mode === "at_age" ? "At publish-age" : "Current metrics";

      // All interpolations escaped (enum values today, but never interpolate raw).
      const html = `
        <div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#18181b;line-height:1.6">
          <h2 style="font-size:16px;margin:0 0 8px">PostAutomation — Insights report</h2>
          <p style="margin:0 0 4px">Window: <strong>${escapeHtml(input.window)}</strong> · Mode: <strong>${escapeHtml(modeLabel)}</strong></p>
          <p style="margin:0 0 4px">${rows.length} row${rows.length === 1 ? "" : "s"} attached as CSV${truncated ? " (truncated at the row cap — narrow the window for full coverage)" : ""}.</p>
          <p style="margin:8px 0 0;color:#71717a;font-size:12px">Requested from the Insights &rarr; Reports page. All times UTC.</p>
        </div>`;
      const text = `PostAutomation Insights report\nWindow: ${input.window} · Mode: ${modeLabel}\n${rows.length} rows attached as CSV${truncated ? " (truncated at the row cap)" : ""}. All times UTC.`;

      const sent = await sendEmail({
        to: input.to,
        subject: `PostAutomation report — ${input.window} ${modeLabel} (${day})`,
        html,
        text,
        attachments: [
          {
            filename,
            // BOM prefix makes Excel detect UTF-8 (same as the browser export).
            content: "﻿" + csv,
            contentType: "text/csv; charset=utf-8",
          },
        ],
      });

      if (!sent) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The report email could not be sent. Please try again.",
        });
      }

      // Arbitrary-recipient sends are always audit-logged (fire-and-forget —
      // never blocks the send result; mirrors rss.router usage).
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.ANALYTICS_REPORT_EMAILED,
        entityType: "AnalyticsReport",
        metadata: { to: input.to, window: input.window, mode: input.mode, rows: rows.length },
      }).catch((err) => {
        console.error("audit_log_write_failed", { err: err.message, action: AUDIT_ACTIONS.ANALYTICS_REPORT_EMAILED });
      });

      return { sent: true, rows: rows.length };
    }),
});
