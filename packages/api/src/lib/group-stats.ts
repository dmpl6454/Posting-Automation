import { pooledEngagementRate, type RateVerdict } from "./engagement-rate";

/**
 * Pure aggregation for group-wise ("campaign") analytics: fold per-channel
 * metric rows into per-group totals, plus an "Ungrouped" bucket for channels
 * that belong to no group.
 *
 * Semantics (owner decision 2026-07-17):
 *  - A channel that belongs to MULTIPLE groups counts in EACH of them (the UI
 *    footnotes this), so group totals are NOT expected to sum to the org total.
 *  - Both `channelRows` and the group membership passed in are ACTIVE channels
 *    only (the caller filters `isActive: true`), so a group's channelCount is
 *    its active-member count — reconciling with the Channel Performance table
 *    (active-only) and the Compose group quick-select counts.
 *  - `channelRows` only contains channels with ≥1 published target in the
 *    window (the SQL aggregate GROUPs BY channelId), so a group's channelCount
 *    comes from its membership list, not from the rows. The Ungrouped bucket's
 *    channelCount comes from `ungroupedChannelCount` (all active ungrouped
 *    channels) rather than the row count (only ungrouped channels WITH activity)
 *    so its semantics match the group rows.
 *  - engagementRate is recomputed FROM THE SUMS ((likes+comments+shares) /
 *    impressions × 100) — never averaged from per-channel rates — matching the
 *    Insights engagement procedure. Zero impressions → 0.
 *
 * Pure + synchronous so it's unit-testable without Prisma
 * (packages/api/src/__tests__/group-stats.test.ts).
 */

import type { MetricKey } from "./platform-metrics";

/** One per-channel aggregate row (already Number()-normalized, no BigInts). */
export interface ChannelStatRow {
  channelId: string;
  posts: number;
  /**
   * The EFFECTIVE unavailable list for this channel (static platform map ∪
   * per-capture overrides), as computed by effectiveChannelUnavailable. Supplied
   * by perChannelStats' caller so group rows can inherit the same honesty rules
   * instead of rendering a fake 0. Optional: older callers/tests omit it.
   */
  unavailable?: MetricKey[];
  impressions: number;
  reach: number;
  /**
   * Views. Summed over rows that actually captured one — a NULL views column
   * means "never captured" and contributes nothing, so this is never inflated by
   * rows that predate the metric.
   */
  views?: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  /** true when ≥1 of the channel's targets has a captured snapshot (UI: — vs 0). */
  hasSnapshot?: boolean;
  /**
   * Sums restricted to snapshots that actually reported impressions — the ONLY
   * honest basis for an engagement rate.
   *
   * ⚠️ Why these exist. The rate used to be `Σ(likes+comments+shares) ÷ Σ(impressions)`
   * over ALL of a channel's posts. On Facebook only VIDEO posts carry an
   * impression figure, so a channel's entire reaction count was divided by one
   * video's view count. Measured on prod: a channel with 7 posts, 14 reactions
   * and a single 1-view video rendered **1400.00%**. The correct rule (already
   * documented in engagement-rate.ts and used by analytics.engagement) is that
   * only rows WITH impressions contribute to BOTH sides.
   */
  impressionedImpressions?: number;
  impressionedLikes?: number;
  impressionedComments?: number;
  impressionedShares?: number;
  /** How many of this channel's posts reported impressions (rate's real base). */
  impressionedPosts?: number;
  /**
   * Per-metric availability DECLARED by the captures themselves
   * (AnalyticsSnapshot.metadata.metricsAvailable), aggregated across this
   * channel's targets: true ⇒ at least one capture actually reported that metric.
   * Lets a per-post capability override the platform-wide static map — see
   * effectiveChannelUnavailable in platform-metrics.ts.
   */
  declaredAvailable?: Partial<
    Record<"impressions" | "reach" | "views" | "likes" | "comments" | "shares" | "clicks", boolean>
  >;
  /**
   * true when ≥1 capture predates the honesty metadata (snapshot with no
   * metadata at all). Those rows carry no capability claim, so the static
   * platform map must still be consulted for them.
   */
  hasLegacySnapshot?: boolean;
}

/** Group shape as selected from prisma.channelGroup.findMany. */
export interface GroupWithChannels {
  id: string;
  name: string;
  color: string;
  channels: { id: string }[];
}

export interface GroupStatsRow {
  id: string;
  name: string;
  color: string;
  channelCount: number;
  posts: number;
  impressions: number;
  reach: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  /**
   * Percent (0–100) computed from the summed metrics, or NULL when the group
   * has no impressioned base or the summed interactions EXCEED the summed
   * impressions (a cross-source mismatch — see engagement-rate.ts).
   */
  engagementRate: number | null;
  /** Why the rate is null, and whether its base is thin. */
  engagementRateFlags: { lowBase: boolean; reason: "no_basis" | "rate_impossible" | null };
  /**
   * Metrics NO member channel of this group can report — the group-level
   * equivalent of the per-channel `unavailable` list.
   *
   * ⚠️ Why this exists. Group Performance summed raw metrics and rendered them
   * with formatNumber(), consulting no capability metadata at all — so the SAME
   * data rendered "—" in Channel Performance and "0" in Group Performance, one
   * card apart on one page. Measured on prod: the FB-only group "fb" showed
   * "Reach 0" while both its channels declared reach unavailable.
   *
   * (Historical note: that FB reach gap was attributed to Meta deleting the
   * Page-post metric. Meta RENAMED it — post_total_media_view_unique works on the
   * approved scopes as of 2026-08-11 — so FB channels now DO declare reach
   * available. The capability gate below is unchanged and still correct, because
   * it reads per-capture declarations rather than assuming per platform.)
   *
   * A metric is unavailable for the GROUP only when EVERY contributing channel
   * marks it unavailable; if one member can report it, the sum is meaningful.
   */
  unavailable: MetricKey[];
  /**
   * How narrow the rate's base is, same semantics as the per-channel row: a rate
   * pooled over one impressioned post must not read as the group's overall rate.
   */
  engagementRateBasis: { impressionedPosts: number; totalPosts: number };
  /** false ⇒ no member channel has a captured snapshot yet (render "—", not 0). */
  hasSnapshot: boolean;
}

/** Sentinel id for the bucket of channels that belong to no group. */
export const UNGROUPED_ID = "__ungrouped__";
const UNGROUPED_COLOR = "#94a3b8"; // slate-400 — neutral, never a real group color

function emptySums() {
  return { posts: 0, impressions: 0, reach: 0, views: 0, likes: 0, comments: 0, shares: 0, clicks: 0 };
}

function addRow(sums: ReturnType<typeof emptySums>, row: ChannelStatRow) {
  sums.posts += row.posts;
  sums.impressions += row.impressions;
  sums.reach += row.reach;
  // Absent on rows that predate the column — contributes nothing rather than 0.
  sums.views += row.views ?? 0;
  sums.likes += row.likes;
  sums.comments += row.comments;
  sums.shares += row.shares;
  sums.clicks += row.clicks;
}

/**
 * Engagement rate pooled over IMPRESSIONED POSTS.
 *
 * ⚠️ This used to pool at CHANNEL granularity — it skipped channels whose total
 * impressions were 0, but for the channels it kept it added their FULL
 * like/comment/share totals over a denominator built from only their impressioned
 * posts. That inherited the exact numerator inflation this rule exists to
 * prevent, one level up: the "fb" group measured 32.76% where the truth was
 * ~10.34%. Using the per-channel impressioned-only sums fixes both levels with
 * one change. Returns a 0–100 percent.
 */
function rateFromRows(rows: ChannelStatRow[]): RateVerdict {
  let num = 0;
  let den = 0;
  let posts = 0;
  for (const r of rows) {
    // Prefer the impressioned-only sums; fall back to the raw ones only for
    // callers (older tests) that don't supply them.
    const imp = r.impressionedImpressions ?? (r.impressions > 0 ? r.impressions : 0);
    if (imp > 0) {
      num +=
        (r.impressionedLikes ?? r.likes) +
        (r.impressionedComments ?? r.comments) +
        (r.impressionedShares ?? r.shares);
      den += imp;
      // Fall back to 1 for callers that don't supply impressionedPosts (older
      // tests, and the raw-sums path above). This count only distinguishes
      // "no basis" from "a basis"; the DENOMINATOR is what gates the rate, so
      // defaulting to 1 must never let a zero-impression row through — `imp > 0`
      // already guarantees it cannot.
      posts += r.impressionedPosts ?? 1;
    }
  }
  // ⚠️ Aggregate FIRST, judge the summed base — do NOT drop sub-threshold member
  // channels. A group of twelve 50-impression channels is a legitimate
  // 600-impression base; excluding its members would understate the group.
  return pooledEngagementRate({ impressions: den, interactions: num, impressionedPosts: posts });
}

const ALL_METRIC_KEYS: MetricKey[] = [
  "impressions",
  "reach",
  "views",
  "likes",
  "comments",
  "shares",
  "clicks",
];

/**
 * A metric is unavailable for a GROUP only when EVERY contributing channel marks
 * it unavailable. If even one member can report it, the summed number is real
 * and must be shown (a mixed FB+IG group keeps Reach, because IG reports it).
 *
 * Rows with NO capability info (older callers/tests) are treated as "can report"
 * so this can never hide a number that used to be visible.
 */
function groupUnavailable(rows: ChannelStatRow[]): MetricKey[] {
  if (rows.length === 0) return [];
  return ALL_METRIC_KEYS.filter((key) =>
    rows.every((r) => (r.unavailable ?? []).includes(key))
  );
}

/** How many of the group's posts reported impressions (the rate's real base). */
function basisFromRows(rows: ChannelStatRow[]): {
  impressionedPosts: number;
  totalPosts: number;
} {
  let impressionedPosts = 0;
  let totalPosts = 0;
  for (const r of rows) {
    impressionedPosts += r.impressionedPosts ?? 0;
    totalPosts += r.posts;
  }
  return { impressionedPosts, totalPosts };
}

export function sumChannelRowsIntoGroups(
  groups: GroupWithChannels[],
  channelRows: ChannelStatRow[],
  /**
   * Count of active channels that belong to NO group. When provided, it drives
   * the Ungrouped bucket's channelCount (membership semantics, matching group
   * rows). When omitted, falls back to the count of ungrouped channels that
   * have activity in-window (activity semantics — used by the unit tests).
   */
  ungroupedChannelCount?: number
): GroupStatsRow[] {
  const rowByChannel = new Map(channelRows.map((r) => [r.channelId, r]));
  const groupedChannelIds = new Set<string>();

  const result: GroupStatsRow[] = groups.map((group) => {
    const sums = emptySums();
    const groupRows: ChannelStatRow[] = [];
    for (const channel of group.channels) {
      groupedChannelIds.add(channel.id);
      const row = rowByChannel.get(channel.id);
      if (row) {
        addRow(sums, row);
        groupRows.push(row);
      }
    }
    const groupRate = rateFromRows(groupRows);
    return {
      id: group.id,
      name: group.name,
      color: group.color,
      channelCount: group.channels.length,
      ...sums,
      engagementRate: groupRate.rate,
      engagementRateFlags: { lowBase: groupRate.lowBase, reason: groupRate.reason ?? null },
      unavailable: groupUnavailable(groupRows),
      engagementRateBasis: basisFromRows(groupRows),
      hasSnapshot: groupRows.some((r) => r.hasSnapshot !== false),
    };
  });

  // Ungrouped bucket: channels that appear in NO group. Metrics come from the
  // ungrouped channels WITH activity; the channelCount prefers the true active
  // ungrouped-channel count (membership semantics) when the caller supplies it.
  const ungrouped = channelRows.filter((r) => !groupedChannelIds.has(r.channelId));
  const ungroupedCount = ungroupedChannelCount ?? ungrouped.length;
  if (ungroupedCount > 0 || ungrouped.length > 0) {
    const sums = emptySums();
    for (const row of ungrouped) addRow(sums, row);
    const ungroupedRate = rateFromRows(ungrouped);
    result.push({
      id: UNGROUPED_ID,
      name: "Ungrouped",
      color: UNGROUPED_COLOR,
      channelCount: ungroupedCount,
      ...sums,
      engagementRate: ungroupedRate.rate,
      engagementRateFlags: {
        lowBase: ungroupedRate.lowBase,
        reason: ungroupedRate.reason ?? null,
      },
      unavailable: groupUnavailable(ungrouped),
      engagementRateBasis: basisFromRows(ungrouped),
      hasSnapshot: ungrouped.some((r) => r.hasSnapshot !== false),
    });
  }

  return result;
}
