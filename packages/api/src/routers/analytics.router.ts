import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { analyticsSyncQueue, externalPostSyncQueue } from "@postautomation/queue";
import { groupChannelsIntoAccounts } from "../lib/sync-accounts";
import { externalPostFloor, externalPostFloorLabel } from "../lib/external-post-floor";
import { insightsIncludeExternalPosts } from "../lib/insights-population";
import type { PrismaClient } from "@postautomation/db";
import {
  sumChannelRowsIntoGroups,
  type ChannelStatRow,
} from "../lib/group-stats";
import { pooledEngagementRate } from "../lib/engagement-rate";
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
/**
 * ⚠️ EXPORTED so chat.router's `get_analytics` can reuse it. CLAUDE.md records an
 * invariant that chat and the dashboard must agree; chat had its own bespoke SQL,
 * which drifted the moment this aggregate learned about external posts and views.
 * Sharing the query makes them agree BY CONSTRUCTION rather than by parallel
 * maintenance.
 */
export async function fetchChannelStatRows(
  prisma: PrismaClient,
  organizationId: string,
  from: Date,
  to: Date,
  /**
   * Optional per-platform view (e.g. "FACEBOOK"). Omitted/undefined ⇒ every
   * platform, byte-identical to the pre-2026-08-08 behavior.
   *
   * Filtering SERVER-side is deliberate: the caller's row set also drives
   * `reportableMetrics`, so a client-side filter would leave capability computed
   * org-wide while the numbers narrowed — the same class of same-page
   * disagreement Phase 2 just removed.
   */
  platform?: string
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

  // ── WHICH POPULATION (owner decision 2026-08-19) ────────────────────────────
  // Insights reports on posts published THROUGH PostAutomation, end to end.
  // Posts made directly on a connected FB Page / IG account are excluded, and the
  // worker makes no Graph calls to collect them. See insights-population.ts.
  //
  // ⚠️ `all_rows` stays a CTE even with a single arm, on purpose. Keeping it means
  // the ~60-line outer aggregate below — and therefore EVERY honesty rule in it
  // (availExpr, the impressioned-only sums, COUNT(DISTINCT post_key),
  // hasLegacySnapshot) — is byte-identical in both modes. Inlining app_rows into
  // the outer SELECT would be a "tidier" diff that silently re-derives all of it.
  //
  // ⚠️ The positional params are UNCHANGED ($1 org, $2 from, $3 to, $4 platform).
  // The dropped arm consumed the same four, so nothing renumbers. Getting this
  // wrong would rescope the aggregate to another organization — an IDOR.
  const includeExternal = insightsIncludeExternalPosts();

  const extRowsCte = includeExternal
    ? `,
     ext_rows AS (
       SELECT ep."channelId"                       AS channel_id,
              'e:' || ep.id                        AS post_key,
              ep.impressions, ep.reach, ep.likes, ep.comments, ep.shares, ep.clicks,
              -- Same position as app_rows — UNION ALL matches by ORDER, not name.
              ep.views,
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
         AND ($4::text IS NULL OR c2.platform::text = $4)
     )`
    : "";

  const allRowsBody = includeExternal
    ? `SELECT * FROM app_rows
       UNION ALL
       SELECT * FROM ext_rows`
    : `SELECT * FROM app_rows`;

  const rows: Array<{
    channelId: string;
    posts: bigint;
    impressions: bigint;
    reach: bigint;
    likes: bigint;
    comments: bigint;
    shares: bigint;
    clicks: bigint;
    views: bigint;
    availViews: boolean | null;
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
    // ONE aggregate, one population by default:
    //   app_rows — posts published THROUGH PostAutomation (the only population)
    //   ext_rows — posts that exist on the platform but were NOT published by us.
    //              Present ONLY when INSIGHTS_INCLUDE_EXTERNAL_POSTS=true.
    //
    // ⚠️ When present, ext_rows is filtered to `postTargetId IS NULL`, i.e. ONLY posts
    // we did not publish. Posts we DID publish always flow through app_rows, so the
    // external arm can never double-count: if dedup mis-classifies, it loses a row
    // (conservative) rather than inflating a number. That invariant is why toggling the
    // population off cannot change a single app-published figure.
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
              -- ⚠️ NOT COALESCEd to 0. 'views' is a NULLABLE column added after
              -- these rows existed, so NULL genuinely means "never captured".
              -- Availability is derived below as BOOL_OR(views IS NOT NULL) —
              -- the metadata rule (has_meta but key absent => available) would
              -- declare every pre-existing capture's missing views AVAILABLE and
              -- render a confident 0 across all history.
              s.views                              AS views,
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
         -- Optional per-platform view. NULL ⇒ every platform (the default, and
         -- byte-identical to the pre-filter behavior). Parameterized, never
         -- interpolated; org scoping above is untouched.
         AND ($4::text IS NULL OR c.platform::text = $4)
     )${extRowsCte},
     all_rows AS (
       ${allRowsBody}
     )
     SELECT channel_id                       AS "channelId",
            COUNT(DISTINCT post_key)         AS posts,
            COALESCE(SUM(impressions), 0)    AS impressions,
            -- ⚠️ This is a SUM of PER-POST reach, which is NOT reach.
            -- Every platform that reports reach reports it as "distinct people who
            -- saw THIS post", so summing across posts counts the same person once
            -- per post they saw. Facebook is the first platform where this becomes
            -- a large, confidently-wrong number (post_total_media_view_unique
            -- measured 3 / 106 / 1 / 255 / 36 on five posts).
            -- The UI therefore labels this "Reach (summed per post)" rather than
            -- implying a deduplicated audience. A real deduplicated figure needs
            -- the PAGE-level edge (page_total_media_view_unique), which this repo
            -- has no code path for — a separate feature, not a relabel.
            COALESCE(SUM(reach), 0)          AS reach,
            COALESCE(SUM(likes), 0)          AS likes,
            COALESCE(SUM(comments), 0)       AS comments,
            COALESCE(SUM(shares), 0)         AS shares,
            COALESCE(SUM(clicks), 0)         AS clicks,
            -- SUM skips NULLs, so this is the total over rows that actually
            -- captured a view count. availViews below says whether ANY did.
            COALESCE(SUM(views), 0)          AS views,
            -- ⚠️ Honors an explicit declaration too. The column being non-NULL is
            -- the primary evidence, but a capture that stored a value while
            -- declaring views:false must not be counted — value and
            -- declaration disagreeing is the fabricated-zero shape, and the
            -- provider now guarantees they agree. Belt and braces.
            BOOL_OR(views IS NOT NULL AND COALESCE(avail->>'views', 'true') <> 'false') AS "availViews",
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
            -- COUNT(DISTINCT post_key), not COUNT(*): the "posts" column above is
            -- distinct, so a post carrying two rows (e.g. two snapshots at the
            -- same snapshotAt) made the disclosed basis chip print a numerator
            -- ABOVE its denominator — "(2/1)". Both sides must count the same thing.
            COUNT(DISTINCT post_key) FILTER (WHERE impressions > 0)       AS "impressionedPosts",
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
    to,
    platform ?? null
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
    views: Number(r.views),
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
      // Derived from the DATA (BOOL_OR(views IS NOT NULL)), not from a
      // metricsAvailable key — see the SQL comment. `views` is nullable and
      // therefore self-describing, and the metadata rule would have declared it
      // available on every capture that predates the column.
      views: tri(r.availViews),
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
  /** Views. null ⇒ not reported by this platform / never captured ⇒ "—". */
  views?: number | null;
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
  /**
   * false ⇒ this post was LISTED but its metrics were never fetched, so every
   * metric is UNKNOWN rather than zero.
   *
   * ⚠️ This flag is load-bearing for ExternalPost rows and cannot be inferred from
   * the values. `ExternalPost.impressions/clicks/likes/comments/shares/reach` are
   * `Int @default(0)` (NOT NULL, schema.prisma:324-329), so a never-measured row
   * PHYSICALLY STORES 0 and is byte-indistinguishable from a measured zero. Only
   * `views` is nullable. The app-published arm is safe by accident of SQL shape —
   * its LEFT JOIN LATERAL yields SQL NULL when no snapshot matched — but the
   * external arm structurally cannot honor that contract, so the "no data" signal
   * has to be projected explicitly.
   *
   * This mirrors metricCellValue's FIRST rule (`if (meta.hasSnapshot === false)
   * return null`, apps/web/lib/metric-cell.ts:40), which is what has always made
   * the Channel Performance aggregate honest while Reports was not.
   *
   * Absent (undefined) on legacy callers ⇒ no gating, byte-identical to previous
   * behavior. Only an explicit `false` blanks the row.
   */
  hasMetrics?: boolean;
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
  // Listed but never measured ⇒ NOTHING was captured, so every metric is unknown.
  // Checked with `=== false` so an absent flag (legacy callers, existing tests)
  // leaves behavior byte-identical. See PostReportRow.hasMetrics for why the
  // values themselves cannot carry this signal.
  const neverMeasured = r.hasMetrics === false;
  const gate = (
    key: "impressions" | "reach" | "likes" | "comments" | "shares" | "clicks" | "views",
    v: number | null
  ): number | null => {
    if (neverMeasured) return null;
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
  const gatedViews = gate("views", r.views ?? null);
  /**
   * The rate's denominator is the platform's DELIVERY count.
   *
   * ⚠️ It cannot be "impressions" alone. Instagram, YouTube, Threads, dev.to and
   * Reddit expose NO impressions metric — what their providers store in that slot
   * has always been a VIEW count, and those platforms now declare impressions
   * unavailable so the UI stops showing the same number under two names. Gating
   * the rate on impressions alone would therefore blank the engagement rate for
   * every Instagram and YouTube channel, which is the largest population here.
   */
  const rateDenominator = gatedImpressions ?? gatedViews;
  return {
    ...r,
    impressions: gatedImpressions,
    views: gatedViews,
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
    // A second gate on top: even with a visible denominator, interactions that
    // EXCEED impressions mean the two sides came from different metric sources
    // (FB reactions from the insights edge vs. views from video_insights/the
    // scraper). Uses the GATED values so a metric rendering "—" cannot drive it.
    engagementRate:
      rateDenominator === null || r.engagementRate === null
        ? null
        : (gate("likes", r.likes) ?? 0) +
              (gate("comments", r.comments) ?? 0) +
              (gate("shares", r.shares) ?? 0) >
            rateDenominator
          ? null
          : Number(r.engagementRate),
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
  limit: number,
  /** Optional per-platform view. Undefined ⇒ every platform (unchanged). */
  platform?: string
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

  // Optional per-platform view, applied to BOTH union arms.
  //
  // ⚠️ Server-side is MANDATORY here, not a nicety: this query is capped at
  // `limit` (500 for the table, 1000 for the export) and ordered by publishedAt.
  // A client-side filter would silently drop a platform whose rows all sit past
  // the cap — a cap that changes a displayed value, which this codebase counts
  // as a bug (see the EXTERNAL_LIST_PAGE_HARD_STOP note).
  params.push(platform ?? null);
  const platformIdx = params.length;
  const platformFilterApp = `AND ($${platformIdx}::text IS NULL OR c.platform::text = $${platformIdx})`;
  const platformFilterExt = `AND ($${platformIdx}::text IS NULL OR c2.platform::text = $${platformIdx})`;

  // Platform-native posts (not published through us) are unioned in ONLY when the
  // population switch is on AND the mode is "current".
  //
  // ⚠️ Two independent reasons to exclude, both permanent:
  //   1. Owner decision 2026-08-19 — Reports covers posts sent through PostAutomation.
  //   2. "at_age" NEVER included them: those rows are pinned to at-age CHECKPOINT
  //      snapshots that only exist for posts we published (the delayed jobs are
  //      enqueued at publish time), so an external post can never have one. Including
  //      them would render a table of "—" and misrepresent at-age coverage.
  // So the disabled branch is NOT new code — it is the branch at_age mode has taken
  // since PR #162, which is why it needs no separate correctness argument.
  const externalUnion =
    mode === "current" && insightsIncludeExternalPosts()
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
            ep.impressions, ep.clicks, ep.likes, ep.comments, ep.shares, ep.reach, ep.views,
            CASE
              WHEN ep.impressions > 0
                THEN (ep.likes + ep.comments + ep.shares)::float / ep.impressions * 100
              -- A measured row with ZERO impressions has an undefined rate, not a
              -- zero one: 0/0. Emitting 0 here read as "no engagement" when the
              -- truth is "no denominator".
              WHEN ep."metricsSyncedAt" IS NOT NULL AND ep.impressions > 0 THEN 0
              ELSE NULL
            END AS "engagementRate",
            ep."metricsSyncedAt" AS "snapshotAt",
            -- Shape the honesty metadata like a snapshot's so gatePostReportRow needs
            -- no special case: it reads metadata.metricsAvailable either way.
            CASE WHEN ep."metricsAvailable" IS NULL THEN NULL
                 ELSE jsonb_build_object('metricsAvailable', ep."metricsAvailable") END AS "snapshotMetadata",
            TRUE AS "isExternal",
            -- Listed but never measured ⇒ every metric is UNKNOWN, not zero. The
            -- counter columns are Int @default(0) NOT NULL, so a never-measured row
            -- stores a 0 that is indistinguishable from a measured zero — this is the
            -- only signal that separates them. Mirrors the aggregate's has_metrics
            -- (:181-182) so the table and Channel Performance finally agree.
            (ep."metricsSyncedAt" IS NOT NULL) AS "hasMetrics"
     FROM "ExternalPost" ep
     INNER JOIN "Channel" c2 ON c2.id = ep."channelId"
     WHERE c2."organizationId" = $1
       AND ep."postTargetId" IS NULL
       AND ep."publishedAt" >= $2
       ${platformFilterExt}`
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
            s.impressions, s.clicks, s.likes, s.comments, s.shares, s.reach, s.views,
            -- Recompute Eng.% from the raw counts: stored engagementRate is
            -- a 0–1 FRACTION for YT/IG/FB/Reddit but a PERCENT for
            -- Threads/Pinterest/DevTo (mixed units in historical rows).
            -- This matches how the Insights engagement procedure computes it.
            -- NULL means "no denominator" and renders "—". That covers BOTH "no
            -- snapshot captured yet" AND "captured, but zero impressions": a rate
            -- of 0/0 is undefined, and printing 0.00% reads as "no engagement"
            -- when the truth is "nothing was delivered to divide by".
            -- ⚠️ An older version of this comment claimed a zero-impression capture
            -- yields a real 0. It does not, and has not since the AND impressions > 0
            -- clause was appended to the second branch below — which makes that branch
            -- UNREACHABLE (it repeats branch one's predicate). Left in place
            -- deliberately: it is a provable no-op, and the ext_rows arm carries the
            -- identical shape, so removing it here alone would desynchronise them.
            CASE
              WHEN s.impressions > 0
                THEN (s.likes + s.comments + s.shares)::float / s.impressions * 100
              -- Unreachable (see above); ELSE NULL is what actually fires.
              WHEN s."snapshotAt" IS NOT NULL AND s.impressions > 0 THEN 0
              ELSE NULL
            END AS "engagementRate",
            s."snapshotAt",
            -- Per-capture honesty metadata (metricsAvailable) — gatePostReportRow
            -- prefers this over the static per-platform map so a real captured
            -- value (e.g. FB video views) is never hidden as "—".
            s.metadata        AS "snapshotMetadata",
            FALSE AS "isExternal",
            -- Same flag on this arm for symmetry (UNION ALL needs matching columns).
            -- Here it is belt-and-braces: when the LATERAL finds no snapshot every
            -- counter is already SQL NULL, which the gate's null check catches. It
            -- must stay derived from snapshotAt so at_age rows — non-null by
            -- construction — are never blanked.
            (s."snapshotAt" IS NOT NULL) AS "hasMetrics"
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
       ${platformFilterApp}
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

      // Published through PostAutomation over ALL TIME, ignoring the window.
      //
      // ⚠️ Exists so an empty page can tell the truth about WHY it is empty. Measured
      // on prod 2026-08-21: 11 orgs have ever published through PostAutomation but
      // only 5 did so inside the default 30-day window — so six orgs own real history
      // and saw a blank Insights page. "You haven't published here" would be false for
      // them; the honest message is "not in this range, widen it". Until 2026-08-19
      // the direct-post population always filled the window, which is why this
      // distinction never had to exist.
      //
      // A cheap COUNT on an indexed status + org join, run once per page load.
      const publishedAllTime = await ctx.prisma.postTarget.count({
        where: { status: "PUBLISHED", post: { organizationId: ctx.organizationId } },
      });

      return {
        totalPosts,
        totalTargets,
        published,
        failed,
        publishedAllTime,
        period: { from, to },
      };
    }),

  /** Aggregated engagement metrics across all published posts */
  engagement: orgProcedure
    .input(
      z.object({
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        /**
         * Optional per-platform view. Bound as a QUERY PARAMETER, never
         * interpolated, so an unrecognized value simply matches no rows.
         */
        platform: z.string().optional(),
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
      const statRows = await fetchChannelStatRows(
        ctx.prisma,
        ctx.organizationId,
        from,
        to,
        input.platform
      );

      // Which metrics ANY connected platform can ever report. Lets the UI drop
      // dead tiles/cards entirely instead of showing a confident "0" for a
      // metric that is structurally impossible — e.g. "Total Reach: 0" on an
      // org with only Facebook channels, where Meta deleted the reach metric.
      // Includes paused/disconnected channels: their history still counts toward
      // the totals above (soft-delete decision 2026-08-06), so a metric only
      // THEY can report must keep its tile rather than having the tile dropped
      // while its number is still being summed into the totals.
      const orgChannels = await ctx.prisma.channel.findMany({
        // ⚠️ The platform filter must narrow CAPABILITY as well as the numbers.
        // Without it a filtered view computes reportableMetrics over EVERY
        // connected platform, so selecting "Instagram" still renders tiles for
        // metrics only Facebook can report — as a hard 0, with no "—" path.
        // perChannelStats already scopes this way.
        where: {
          organizationId: ctx.organizationId,
          ...(input.platform ? { platform: input.platform as any } : {}),
        },
        select: { platform: true },
      });
      // ⚠️ The SECOND argument is load-bearing and was missing until 2026-08-08.
      // Without it this only ever consulted the static per-platform map, which
      // marks FACEBOOK impressions/reach unavailable — so an org whose Facebook
      // channels DO report video views had the Impressions tile and the "Total
      // Views" card dropped while `perChannelStats` (which does pass the
      // override, via effectiveChannelUnavailable) rendered those same numbers
      // in the table right below. Same page, two answers.
      //
      // This is the PR #148 regression in its other half: capability must widen
      // from what captures actually reported, never from the static map alone.
      const reportable = reportableMetrics(
        orgChannels.map((c) => c.platform as string),
        statRows.map((r) => r.declaredAvailable)
      );

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

      // Same ONE implementation as perChannelStats/groupStats. This procedure
      // previously returned a NON-NULLABLE rate with no basis, so an impossible
      // or baseless rate rendered as a confident "0.00%" on the headline tile —
      // the least honest of the four surfaces.
      const orgRate = pooledEngagementRate({
        impressions: impDen,
        interactions: impNum,
        impressionedPosts: sum((r) => r.impressionedPosts ?? 0),
      });

      return {
        // Does this response include posts made DIRECTLY on the platform?
        //
        // ⚠️ Returned explicitly rather than left for the UI to infer from the
        // presence of a floor label. Six hardcoded "1 Aug 2026" strings once sat in
        // the UI, and the lesson recorded from that was to DERIVE the copy from the
        // server. Inferring the population from a label's absence would repeat the
        // same mistake one level up: an implicit signal the next edit can break
        // without any test noticing.
        includesDirectPosts: insightsIncludeExternalPosts(),
        // Active external-post coverage floor (configurable) — see postReports.
        // Label for copy, ISO instant for the "is this range covered?" gate.
        // Both undefined when direct posts are excluded: there is no coverage
        // boundary to disclose, and a stale "included from …" notice would describe
        // data this page no longer shows.
        externalFloorLabel: insightsIncludeExternalPosts() ? externalPostFloorLabel() : undefined,
        externalFloorIso: insightsIncludeExternalPosts()
          ? externalPostFloor().toISOString()
          : undefined,
        impressions: sum((r) => r.impressions),
        clicks: sum((r) => r.clicks),
        likes: sum((r) => r.likes),
        shares: sum((r) => r.shares),
        comments: sum((r) => r.comments),
        reach: sum((r) => r.reach),
        views: sum((r) => r.views ?? 0),
        engagementRate: orgRate.rate,
        engagementRateBasis: {
          impressionedPosts: orgRate.impressionedPosts,
          totalPosts: sum((r) => r.posts ?? 0),
        },
        engagementRateFlags: {
          lowBase: orgRate.lowBase,
          reason: orgRate.reason ?? null,
        },
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
   *
   * Counts PostTarget rows — posts published THROUGH PostAutomation. Since the
   * 2026-08-19 owner decision that is the population EVERY card on this page uses,
   * including `fetchChannelStatRows` (Channel Performance, Group Performance, the
   * `engagement` tiles), so they now agree by construction.
   *
   * ⚠️ HISTORY worth keeping, because the divergence returns the moment
   * INSIGHTS_INCLUDE_EXTERNAL_POSTS is set: between 2026-08-07 and 2026-08-19
   * `fetchChannelStatRows` UNIONed in ExternalPost (posts made directly on connected
   * FB Pages / IG accounts) while this query did not, so this card and the table
   * beside it disagreed enormously — measured on prod 2026-08-13, one workspace had
   * 0 here against 28,401 in the table.
   *
   * Do NOT widen this query to match without an explicit product decision:
   * "what did I publish?" and "what is on my channels?" are both valid questions.
   * What is NOT acceptable is showing them side by side unlabelled — which is why
   * the UI's qualifiers are gated on the server's `includesDirectPosts` rather than
   * deleted, so re-enabling the population restores the disclosure with it.
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

  /**
   * Daily post count over time.
   *
   * ⚠️ APP-PUBLISHED ONLY — same narrower population as `platformBreakdown`; see
   * the note there for why it deliberately disagrees with Channel Performance and
   * why the UI must keep saying so.
   */
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
        /**
         * Optional per-platform view. Bound as a QUERY PARAMETER, never
         * interpolated, so an unrecognized value simply matches no rows.
         */
        platform: z.string().optional(),
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
          where: {
            organizationId: ctx.organizationId,
            // Narrow the CHANNEL list with the same predicate as the stat rows.
            // Filtering only one of the two would render empty rows for the
            // other platforms instead of removing them.
            ...(input.platform ? { platform: input.platform as any } : {}),
          },
        }),
        fetchChannelStatRows(ctx.prisma, ctx.organizationId, from, to, input.platform),
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
        // ONE implementation for every granularity — see engagement-rate.ts.
        // Suppresses only the definitionally impossible (interactions >
        // impressions, a cross-source mismatch that rendered 200% on prod) and
        // flags a thin base without hiding it.
        const rateVerdict = pooledEngagementRate({
          impressions: impDen,
          interactions: impNum,
          impressionedPosts: m?.impressionedPosts ?? 0,
        });
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
          views: m?.views ?? 0,
          engagementRate: rateVerdict.rate,
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
          /**
           * Why the rate is "—", or why it carries a low-base chip. The UI must
           * NOT reuse the generic "unavailable" tooltip for `rate_impossible` —
           * "we could not read it" and "we read it and it is impossible" are
           * different facts.
           */
          engagementRateFlags: {
            lowBase: rateVerdict.lowBase,
            reason: rateVerdict.reason ?? null,
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
  /**
   * Platforms this org actually has channels on — the pill row for the
   * per-platform Insights view.
   *
   * ⚠️ Deliberately UNFILTERED by the selected platform. If the pill list were
   * derived from the filtered rows, choosing "Facebook" would delete every other
   * pill and strand the user with no way back.
   *
   * Deliberately NOT window-scoped either: a platform whose posts all fall
   * outside the selected date range must still offer its pill, otherwise the
   * control vanishes exactly when someone is trying to find out why a platform
   * looks empty. Cheap — one DISTINCT over an indexed org column.
   *
   * Includes paused/disconnected channels, matching the stat aggregate, which
   * counts their history (soft-delete decision 2026-08-06).
   */
  platformsInWindow: orgProcedure.query(async ({ ctx }) => {
    const rows = await ctx.prisma.channel.findMany({
      where: { organizationId: ctx.organizationId },
      select: { platform: true },
      distinct: ["platform"],
    });
    return rows.map((r) => r.platform as string).sort();
  }),

  insightsHealth: orgProcedure.query(async ({ ctx }) => {
    // ⚠️ SCOPED TO THE POPULATION INSIGHTS MEASURES, or this banner nags forever.
    //
    // Measured on prod 2026-08-19: 673 active channels carried `needs_reconnect` and
    // 665 of them (98.8%) had never held an app-published PostTarget. Those verdicts
    // were written by `external-post-sync.worker`'s writeHealth. With that sweep
    // dormant (Insights covers app-published posts only), such a channel is visited
    // by NEITHER health writer — analytics-sync iterates app-published targets, of
    // which it has none — and `shouldApplyHealthVerdict` only clears a
    // `needs_reconnect` on a later CLEAN capture. So the verdict freezes on screen
    // and tells the user to reconnect hundreds of channels to restore metrics the
    // pipeline no longer gathers: the perpetual-banner class PR #170 fixed, reached
    // through a new mechanism.
    //
    // Scoping to channels with published history is self-maintaining rather than a
    // one-off data patch: it is EXACTLY the set analytics-sync revisits, so verdicts
    // here stay fresh and can still self-clear. When direct posts are included the
    // wider population can report Insights again, so the scope is dropped and this
    // is byte-identical to the pre-2026-08-19 query.
    const measuredOnly = !insightsIncludeExternalPosts();
    const channels = await ctx.prisma.channel.findMany({
      where: {
        organizationId: ctx.organizationId,
        isActive: true,
        ...(measuredOnly ? { postTargets: { some: { status: "PUBLISHED" as const } } } : {}),
      },
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
        /**
         * ⚠️ ACCEPTED AND DELIBERATELY IGNORED.
         *
         * A ChannelGroup may span platforms, so "the Facebook view of a group"
         * is undefined: narrowing the rows would silently redefine each group as
         * a partial version of itself, and its Channels count would no longer
         * match its own membership. The UI hides the Group Performance card on a
         * platform view instead.
         *
         * The input exists so the client can pass one options object to all
         * three procedures without special-casing this one.
         */
        platform: z.string().optional(),
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

    // Direct-post refresh — only when that population is part of Insights.
    //
    // ⚠️ Gated at the QUERY, not just the enqueue. Insights covers posts published
    // through PostAutomation (owner decision 2026-08-19), so fetching the org's Meta
    // channels here would be a round-trip whose only possible use is work we have
    // decided not to do. When enabled, the account-level keying matches the cron: one
    // job per DISTINCT platformId fanned out to every channel row for it, so it costs
    // 1 Graph call per account rather than one per row.
    const metaChannels = insightsIncludeExternalPosts()
      ? await ctx.prisma.channel.findMany({
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
        })
      : [];

    // Stays 0 when excluded, so the toast cannot claim direct posts are refreshing
    // when nothing was queued. The UI reads this to build its message.
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
            since: externalPostFloor().toISOString(),
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
   * Metric caveats (platform APIs, not bugs): `views` and `impressions` are
   * SEPARATE columns as of 2026-08-13 — Instagram/YouTube/Threads/dev.to/Reddit
   * report only views (they have no impressions metric at all and declare it
   * unavailable), while Facebook reports both and they differ ~3.45x
   * (post_media_view counts plays/renders, post_video_views counts watched
   * video). Twitter metrics are 0 on the free API tier; Instagram never exposes
   * clicks.
   */
  postReports: orgProcedure
    .input(
      z.object({
        window: z.enum(["24h", "7d", "15d", "30d"]),
        mode: z.enum(["current", "at_age"]).default("current"),
        // 1001 so the export can fetch EXPORT_LIMIT(1000)+1 to detect truncation
        // (distinguish "exactly 1000, complete" from ">1000, truncated").
        limit: z.number().min(1).max(1001).default(500),
        /**
         * Optional per-platform view. MUST be applied server-side: this query is
         * capped by `limit`, so a client-side filter would hide a platform whose
         * rows all sit past the cap.
         */
        platform: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const rows = await fetchPostReportRows(
        ctx.prisma,
        ctx.organizationId,
        input.window,
        input.mode,
        input.limit,
        input.platform
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
        // Whether these rows can contain platform-native ("Direct") posts at all.
        // Drives the Reports coverage paragraph and the Direct badge.
        includesDirectPosts: insightsIncludeExternalPosts(),
        // ⚠️ The coverage floor is CONFIGURABLE (EXTERNAL_POST_FLOOR). BOTH the
        // label and the ISO instant are returned: the UI needs the label for its
        // copy AND the instant to decide whether to show the notice at all. When
        // only the label was returned, the gate kept a hardcoded 2026-08-01 and
        // the notice fired on ranges that were in fact fully covered.
        // Undefined when direct posts are excluded — no boundary to disclose.
        externalFloorLabel: insightsIncludeExternalPosts() ? externalPostFloorLabel() : undefined,
        externalFloorIso: insightsIncludeExternalPosts()
          ? externalPostFloor().toISOString()
          : undefined,
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
        /** Keeps the emailed CSV identical to the filtered table on screen. */
        platform: z.string().optional(),
        limit: z.number().min(1).max(1000).default(1000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await fetchPostReportRows(
        ctx.prisma,
        ctx.organizationId,
        input.window,
        input.mode,
        input.limit,
        input.platform
      );

      if (rows.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No report rows for this window — nothing to email.",
        });
      }

      // Capability-filtered columns, exactly as the Reports page CSV does.
      //
      // ⚠️ These headers were hardcoded, so the EMAILED csv disagreed with the
      // on-screen table and the downloaded csv from the same procedure family: an
      // FB-only org received two permanently-empty columns the UI had dropped.
      // Header and rows are built from ONE filtered list so their indexes cannot
      // drift apart.
      const reportable = new Set(
        reportableMetrics(
          rows.map((r) => r.platform),
          rows.map((r) => r.snapshotMetadata?.metricsAvailable as any)
        )
      );
      const inCsv = (key: string) => reportable.size === 0 || reportable.has(key as any);

      type Row = (typeof rows)[number];
      type CsvCell = string | number | null | undefined;
      const allMetricCols: Array<{ key: string; header: string; get: (r: Row) => CsvCell }> = [
        // ⚠️ Keep this list in step with ReportsTab's allMetricCols. The comment
        // above records that the emailed CSV once drifted from the on-screen
        // table; it drifted again when `views` shipped without this file being
        // touched, so a Threads/Reddit/dev.to org received a CSV with no
        // delivery metric and no rate at all.
        { key: "impressions", header: "Impressions", get: (r) => r.impressions },
        { key: "views", header: "Views", get: (r) => r.views ?? null },
        { key: "clicks", header: "Clicks", get: (r) => r.clicks },
        { key: "likes", header: "Likes", get: (r) => r.likes },
        { key: "comments", header: "Comments", get: (r) => r.comments },
        { key: "shares", header: "Shares", get: (r) => r.shares },
        { key: "reach", header: "Reach", get: (r) => r.reach },
      ];
      const metricCols = allMetricCols.filter((c) => inCsv(c.key));

      const includeSaves = rows.some((r) => r.saved != null);
      // Engagement rate can only be as honest as its denominator, which is
      // impressions OR views — five platforms have no impressions metric at all.
      // Must match ReportsTab's includeEng exactly.
      const includeEng = inCsv("impressions") || inCsv("views");

      const csv = toCsv(
        [
          "Post",
          "Channel",
          "Handle",
          "Platform",
          "Published At (UTC)",
          "Post URL",
          ...metricCols.map((c) => c.header),
          ...(includeSaves ? ["Saves"] : []),
          ...(includeEng ? ["Engagement %"] : []),
          "Metric captured at (UTC)",
        ],
        rows.map((r) => [
          r.contentPreview,
          r.channelName,
          r.channelUsername ?? "",
          r.platform,
          r.publishedAt ? new Date(r.publishedAt).toISOString() : "",
          r.publishedUrl ?? "",
          ...metricCols.map((c) => c.get(r)),
          ...(includeSaves ? [r.saved] : []),
          // A suppressed rate carries a reason token so an owner reconciling the
          // email against the page can tell "not reported" from "measured zero".
          ...(includeEng ? [r.engagementRate === null ? "—" : r.engagementRate] : []),
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
