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
  /**
   * Did ANY capture land for this channel in the window? Separates a settled zero
   * from a pending one — see the `zero_engagement` note below.
   */
  hasSnapshot?: boolean;
}

export type InsightsEmptyState =
  /** Show nothing — there is real data, or another empty state owns this case. */
  | "none"
  /** Connected, and this workspace has NEVER published through us. */
  | "no_app_posts"
  /**
   * Published through us before, but not inside the selected window.
   *
   * ⚠️ Distinct from `no_app_posts` because the honest advice is opposite: widen the
   * range, don't go create a post. MEASURED on prod 2026-08-21 — 11 orgs have ever
   * published through PostAutomation but only 5 did so within the default 30-day
   * window, so six orgs own real history and saw a blank page. Telling them they
   * hadn't published would be flatly false.
   */
  | "no_app_posts_in_range"
  /** Posts exist; their metrics have not arrived yet. "Sync Now" is valid advice. */
  | "no_metrics_yet"
  /**
   * Posts exist AND were captured; the engagement really is zero.
   *
   * ⚠️ Observed on prod 2026-08-21: Tabish's Workspace showed "no engagement data has
   * synced yet — try Sync Now" for two posts that BOTH already had snapshots. The
   * banner blamed a pending sync for a settled fact, and Sync Now could never change
   * it. Suggesting a refresh here is the same falsehood as the banner this replaced.
   */
  | "zero_engagement";

const engagementOf = (r: ChannelStatLike): number =>
  (r.impressions ?? 0) + (r.reach ?? 0) + (r.likes ?? 0) + (r.comments ?? 0) + (r.shares ?? 0);

/**
 * @param rows  Channel stat rows, UNFILTERED by platform. Deriving this from the
 *   platform-filtered rows would flash a whole-org claim the moment someone views a
 *   quiet platform — the same reasoning as the flag this replaces.
 * @param includesDirectPosts Whether the response includes posts made directly on a
 *   platform. When it does, `postCount` counts those too, so a 0 means "no posts of
 *   any kind" and the app-published-specific wording would be wrong.
 * @param publishedAllTime Count of posts this workspace has published through
 *   PostAutomation over ALL time, ignoring the selected window. Optional so an older
 *   cached client payload keeps the previous (still-true) message rather than
 *   claiming history that may not exist.
 */
export function deriveInsightsEmptyState(
  rows: ChannelStatLike[] | undefined,
  includesDirectPosts: boolean,
  publishedAllTime = 0
): InsightsEmptyState {
  if (!rows || rows.length === 0) return "none";

  const anyEngagement = rows.some((r) => engagementOf(r) > 0);
  if (anyEngagement) return "none";

  const anyPosts = rows.some((r) => (r.postCount ?? 0) > 0);
  if (!anyPosts) {
    // With direct posts included, postCount covers them too, so 0 means "no posts of
    // any kind" — fall through to the generic pending message.
    if (includesDirectPosts) return "no_metrics_yet";
    return publishedAllTime > 0 ? "no_app_posts_in_range" : "no_app_posts";
  }

  // Posts exist. "Sync Now" is honest ONLY while a capture is still outstanding —
  // ANY uncaptured channel means real work is pending, so that wins. When every
  // channel has been captured, the zero is settled and must not be blamed on sync.
  const everyPostedRowCaptured = rows
    .filter((r) => (r.postCount ?? 0) > 0)
    .every((r) => r.hasSnapshot === true);

  return everyPostedRowCaptured ? "zero_engagement" : "no_metrics_yet";
}
