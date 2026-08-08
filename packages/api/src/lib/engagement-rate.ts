/**
 * Pooled engagement rate that can't be inflated by zero-impression targets.
 *
 * The old formula was a ratio of SUMs over ALL targets:
 *   SUM(likes+comments+shares) / SUM(impressions) * 100
 * A target that returns engagement but zero impressions (a LinkedIn *member*
 * post, or a Reddit post whose view_count is 0) then dumps its engagement into
 * the numerator with no matching denominator — inflating the org/group rate.
 * e.g. IG (1000 impr, 20 eng = true 2%) + LinkedIn member (0 impr, 80 eng)
 * rendered (20+80)/1000*100 = 10% instead of 2%.
 *
 * Fix: only rows WITH impressions contribute to BOTH numerator and denominator.
 * Returns a 0–100 percent (0 when no impressioned rows exist).
 */
export function computeEngagementRate(
  rows: Array<{ impressions: number; likes: number; comments: number; shares: number }>
): number {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    if (r.impressions > 0) {
      num += (r.likes || 0) + (r.comments || 0) + (r.shares || 0);
      den += r.impressions;
    }
  }
  return den > 0 ? (num / den) * 100 : 0;
}

/**
 * Below this many pooled impressions a rate is real but statistically thin, so
 * it is rendered WITH a "low base" chip rather than withheld.
 *
 * ⚠️ Do NOT raise this to suppress small numbers. It must stay below the
 * smallest prod-verified TRUE rate we are required to keep rendering: the
 * "Bollywood" channel at denominator 57 (7.02%) and the group row at 58
 * (10.34%), both pinned in engagement-rate-pooling.test.ts. 50 is the largest
 * round number under 57. This threshold NEVER suppresses — it only decorates.
 */
export const MIN_CONFIDENT_RATE_IMPRESSIONS = 50;

export type RateVerdict = {
  /** 0–100 percent, or null when the cell must render "—". */
  rate: number | null;
  /** Why the rate is null. Absent when a number is returned. */
  reason?: "no_basis" | "rate_impossible";
  /** 0 < impressions < MIN_CONFIDENT_RATE_IMPRESSIONS. The rate is STILL returned. */
  lowBase: boolean;
  impressions: number;
  interactions: number;
  impressionedPosts: number;
};

/**
 * The ONE engagement-rate decision. Every granularity (org tile, channel row,
 * group row, per-post report row) must route through this so a single page
 * cannot disagree with itself.
 *
 * Two tiers, and only the impossible tier suppresses:
 *
 *   "—"  no_basis        impressionedPosts === 0 or impressions === 0
 *   "—"  rate_impossible interactions > impressions
 *   n%   + low-base chip 0 < impressions < MIN_CONFIDENT_RATE_IMPRESSIONS
 *   n%                   impressions >= MIN_CONFIDENT_RATE_IMPRESSIONS
 *
 * ⚠️ Suppressing merely-SMALL bases was considered and rejected: prod-verified
 * reel denominators are 54/452/17/7/75, so a minimum of 100 would blank three
 * of five legitimate rates. A threshold also does not fix >100%, which is a
 * population mismatch and unbounded at any denominator.
 */
export function pooledEngagementRate(p: {
  impressions: number;
  interactions: number;
  impressionedPosts: number;
}): RateVerdict {
  const base = {
    impressions: p.impressions,
    interactions: p.interactions,
    impressionedPosts: p.impressionedPosts,
    lowBase: false,
  };

  if (p.impressionedPosts <= 0 || p.impressions <= 0) {
    return { ...base, rate: null, reason: "no_basis" };
  }

  if (p.interactions > p.impressions) {
    // Definitionally impossible. Numerator and denominator are summed over the
    // SAME `FILTER (WHERE impressions > 0)` rows, so this can only mean the two
    // sides came from different metric SOURCES — on Facebook, reactions from the
    // post-insights edge against views from video_insights/the reel scraper.
    // Observed on prod 2026-08-08: "Contents of bollywood" rendered 200.00%
    // from 2 interactions over a single 1-view video. Printing that is worse
    // than withholding it.
    return { ...base, rate: null, reason: "rate_impossible" };
  }

  return {
    ...base,
    rate: (p.interactions / p.impressions) * 100,
    lowBase: p.impressions < MIN_CONFIDENT_RATE_IMPRESSIONS,
  };
}
