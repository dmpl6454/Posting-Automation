/**
 * Decides how a single metric cell renders in the Insights/Reports tables so
 * the value is always HONEST:
 *  - "—" when the platform never reports this metric (unavailable), or reach
 *    that is not a distinct metric (aliased from impressions), or no snapshot
 *    has been captured yet.
 *  - the real number otherwise (a captured 0 is a real 0, not "—").
 *
 * Pure + testable (metric-cell.test.ts). The row supplies the honesty metadata
 * that analytics.perChannelStats now returns.
 */
export type MetricKey =
  | "impressions"
  | "reach"
  /**
   * Views. NOT a synonym for impressions: on Facebook the two are separate
   * numbers (renders/plays vs qualified views), and on Instagram / YouTube /
   * Threads / dev.to / Reddit there is no impressions metric at all — those
   * platforms declare impressions unavailable and this key carries the number.
   */
  | "views"
  | "likes"
  | "comments"
  | "shares"
  | "clicks";

export interface MetricRowMeta {
  hasSnapshot?: boolean;
  reachIsDistinct?: boolean;
  unavailable?: MetricKey[];
}

/** Returns the number to format, or null when the cell should render "—". */
export function metricCellValue(
  key: MetricKey,
  value: number,
  meta: MetricRowMeta
): number | null {
  // No analytics captured yet → every metric is "—", never a fake 0.
  if (meta.hasSnapshot === false) return null;
  // Platform never reports this metric → "—".
  if (meta.unavailable?.includes(key)) return null;
  // Reach that is just impressions re-aliased → "—" (kills the duplicate column).
  if (key === "reach" && meta.reachIsDistinct === false) return null;
  return value;
}

export interface RateCellInput {
  engagementRate: number | null | undefined;
  engagementRateBasis?: { impressionedPosts: number; totalPosts: number } | null;
  engagementRateFlags?: { lowBase: boolean; reason: "no_basis" | "rate_impossible" | null } | null;
  /** "post" for channels, "publish" for groups (a post to N channels counts N times). */
  unit?: "post" | "publish";
}

export interface RateCell {
  /** Formatted percent, or null when the cell must render "—". */
  text: string | null;
  /** Reason-specific tooltip. NEVER the generic "unavailable" copy. */
  title: string;
  /** Render a muted "low base" chip beside the number. */
  lowBase: boolean;
  /** "(1/10)" style base disclosure, or null when the base is complete. */
  basis: string | null;
}

/**
 * The ONE engagement-rate cell decision, shared by Channel Performance, Group
 * Performance and the headline tile.
 *
 * ⚠️ The gate is `engagementRate === null`, NOT `impressionedPosts === 0`. A
 * `rate_impossible` verdict has a perfectly non-zero base but still must render
 * "—", so the old post-count test would have printed it.
 *
 * ⚠️ The two null REASONS get different copy on purpose. "We could not read it"
 * and "we read it and it is impossible" are different facts, and reusing the
 * unavailable-metric tooltip for the second one states something false.
 */
export function engagementRateCell(row: RateCellInput): RateCell {
  const unit = row.unit ?? "post";
  const basisData = row.engagementRateBasis;
  const reason = row.engagementRateFlags?.reason ?? null;

  if (row.engagementRate === null || row.engagementRate === undefined) {
    return {
      text: null,
      title:
        reason === "rate_impossible"
          ? `More interactions than recorded views. Facebook reports reactions and video views from different sources, so a rate can't be computed for this row.`
          : `No ${unit} here reported an impression or view count, so there is no denominator to compute a rate from.`,
      lowBase: false,
      basis: null,
    };
  }

  const impressioned = basisData?.impressionedPosts ?? 0;
  const total = basisData?.totalPosts ?? 0;
  const lowBase = row.engagementRateFlags?.lowBase ?? false;

  return {
    text: `${row.engagementRate.toFixed(2)}%`,
    title: lowBase
      ? `Based on a small number of impressions — treat as indicative. Pooled over the ${impressioned} of ${total} ${unit}(s) that reported impressions.`
      : `Pooled over the ${impressioned} of ${total} ${unit}(s) that reported impressions.`,
    lowBase,
    basis: total > 0 && impressioned < total ? `(${impressioned}/${total})` : null,
  };
}

const LIKE_LABELS: Record<string, string> = {
  reactions: "Reactions",
  saves: "Saves",
  upvotes: "Upvotes",
  likes: "Likes",
};

/** Human label + tooltip for the "Likes" column, honest per platform. */
export function likeColumnLabel(likeKind: string | undefined): { label: string; tooltip?: string } {
  switch (likeKind) {
    case "reactions":
      return { label: "Reactions", tooltip: "Facebook reports all reaction types (like, love, haha…), not just likes." };
    case "saves":
      return { label: "Saves", tooltip: "Pinterest has no likes — this is the Pin save count." };
    case "upvotes":
      return { label: "Upvotes", tooltip: "Reddit has no likes — this is the upvote count." };
    default:
      return { label: "Likes" };
  }
}

export { LIKE_LABELS };
