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
