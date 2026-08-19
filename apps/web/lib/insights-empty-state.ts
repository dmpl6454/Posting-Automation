/**
 * Which "nothing here yet" message Channel Performance should show.
 *
 * ⚠️ Why this is a distinction and not one banner. Until 2026-08-19 there was a
 * single message: *"Your channels are connected, but no engagement data has synced
 * yet. Metrics appear after a sync cycle — try Sync Now, or check back later."*
 * That is correct ONLY when a capture is genuinely outstanding.
 *
 * Once Insights narrowed to posts published through PostAutomation, the same banner
 * began firing for every workspace whose activity is mostly DIRECT posts on the
 * platform — where its advice is unachievable. Nothing is pending, so syncing and
 * waiting can never populate the table. That makes it a false statement about the
 * system's state, which is worse than saying nothing: the user is sent to click a
 * button forever instead of being told the population Insights actually covers.
 *
 * The two cases are separable from data already on the row, with no extra query:
 *   postCount === 0 everywhere  ⇒ we published nothing here (syncing is futile)
 *   postCount > 0, metrics all 0 ⇒ a capture really is outstanding (syncing helps)
 */

/** The subset of a perChannelStats row this decision needs. */
export interface ChannelStatLike {
  postCount: number;
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
}

export type InsightsEmptyState =
  /** Show nothing — there is real data, or another empty state owns this case. */
  | "none"
  /** Connected, but this workspace published nothing through us in the window. */
  | "no_app_posts"
  /** Posts exist; their metrics have not arrived yet. "Sync Now" is valid advice. */
  | "no_metrics_yet";

const engagementOf = (r: ChannelStatLike): number =>
  (r.impressions ?? 0) + (r.reach ?? 0) + (r.likes ?? 0) + (r.comments ?? 0) + (r.shares ?? 0);

/**
 * @param rows  Channel stat rows, UNFILTERED by platform. Deriving this from the
 *   platform-filtered rows would flash a whole-org claim the moment someone views a
 *   quiet platform — the same reasoning as the flag this replaces.
 * @param includesDirectPosts Whether the response includes posts made directly on a
 *   platform. When it does, `postCount` counts those too, so a 0 means "no posts of
 *   any kind" and the app-published-specific wording would be wrong.
 */
export function deriveInsightsEmptyState(
  rows: ChannelStatLike[] | undefined,
  includesDirectPosts: boolean
): InsightsEmptyState {
  if (!rows || rows.length === 0) return "none";

  const anyEngagement = rows.some((r) => engagementOf(r) > 0);
  if (anyEngagement) return "none";

  const anyPosts = rows.some((r) => (r.postCount ?? 0) > 0);
  if (!anyPosts && !includesDirectPosts) return "no_app_posts";

  return "no_metrics_yet";
}
