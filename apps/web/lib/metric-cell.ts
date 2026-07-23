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
export type MetricKey = "impressions" | "reach" | "likes" | "comments" | "shares" | "clicks";

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
