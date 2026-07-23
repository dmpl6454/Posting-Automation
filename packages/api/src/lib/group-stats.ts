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

/** One per-channel aggregate row (already Number()-normalized, no BigInts). */
export interface ChannelStatRow {
  channelId: string;
  posts: number;
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  /** true when ≥1 of the channel's targets has a captured snapshot (UI: — vs 0). */
  hasSnapshot?: boolean;
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
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  /** Percent (0–100), computed from the summed metrics. 0 when no impressions. */
  engagementRate: number;
}

/** Sentinel id for the bucket of channels that belong to no group. */
export const UNGROUPED_ID = "__ungrouped__";
const UNGROUPED_COLOR = "#94a3b8"; // slate-400 — neutral, never a real group color

function emptySums() {
  return { posts: 0, impressions: 0, reach: 0, likes: 0, comments: 0, shares: 0, clicks: 0 };
}

function addRow(sums: ReturnType<typeof emptySums>, row: ChannelStatRow) {
  sums.posts += row.posts;
  sums.impressions += row.impressions;
  sums.reach += row.reach;
  sums.likes += row.likes;
  sums.comments += row.comments;
  sums.shares += row.shares;
  sums.clicks += row.clicks;
}

/**
 * Engagement rate pooled ONLY over channels that have impressions, so a
 * zero-impression channel (e.g. a LinkedIn member-only channel with likes but
 * no impressions API) can't inflate the group rate over a denominator it never
 * contributed to. Mirrors packages/api/src/lib/engagement-rate.ts at the
 * channel-row granularity. Returns a 0–100 percent.
 */
function rateFromRows(rows: ChannelStatRow[]): number {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    if (r.impressions > 0) {
      num += r.likes + r.comments + r.shares;
      den += r.impressions;
    }
  }
  return den > 0 ? (num / den) * 100 : 0;
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
    return {
      id: group.id,
      name: group.name,
      color: group.color,
      channelCount: group.channels.length,
      ...sums,
      engagementRate: rateFromRows(groupRows),
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
    result.push({
      id: UNGROUPED_ID,
      name: "Ungrouped",
      color: UNGROUPED_COLOR,
      channelCount: ungroupedCount,
      ...sums,
      engagementRate: rateFromRows(ungrouped),
    });
  }

  return result;
}
