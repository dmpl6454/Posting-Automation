/**
 * Which id should Facebook analytics be requested against?
 *
 * ── Why this exists (LIVE-PROVEN on production 2026-08-25) ────────────────────
 * A Facebook VIDEO/REEL publish stores a BARE Video-node id in
 * `PostTarget.publishedId`, because the `{page}/videos` edge returns only `{id}`.
 * Every other path stores a composite `{pageId}_{postId}`.
 * `FacebookProvider.getPostAnalytics` routes bare ids to the Video node — and the
 * Video node reports NOTHING for a reel. Measured on two real reels:
 *
 *   video_insights on the Video node          → EMPTY200 (no rows)
 *   insights on the resolved POST node        → post_media_view=4,
 *                                               post_total_media_view_unique=1,
 *                                               post_video_views=1
 *
 * So the app was rendering impressions 1 / reach 0 / views "—" for posts that had
 * real numbers available on the same token. The permissions were never at fault.
 *
 * ⚠️ `resolveVideoPostId` previously had exactly ONE caller — the external-post sync
 * — which went dormant on 2026-08-19 when Insights narrowed to app-published posts.
 * From that moment no app-published reel was ever resolved again. This planner moves
 * the decision onto the app-published path.
 *
 * ⚠️ COST: exactly ONE extra Graph call per video target, ONCE, because the caller
 * persists the answer to `PostTarget.metadata.resolvedPostId` and this planner then
 * short-circuits forever. Feed posts and non-Facebook platforms cost nothing.
 *
 * ⚠️ Do NOT move this into the publish path. `getFeedPostAnalytics` carries a
 * "network shape is FROZEN — do not add calls here" contract because it runs inside
 * post-publish. Resolution belongs in analytics-sync, which is allowed to spend a
 * call and can persist the result.
 *
 * Pure + testable, mirroring snapshot-dedup.ts and degraded-capture-guard.ts.
 */
export interface FacebookAnalyticsIdInput {
  platform: string;
  /** PostTarget.publishedId as stored at publish time. */
  publishedId: string | null | undefined;
  /** PostTarget.metadata.resolvedPostId, if a previous run already resolved it. */
  resolvedPostId?: string | null;
}

export interface FacebookAnalyticsIdPlan {
  /** The id to request analytics for, or null when it must be resolved first. */
  analyticsId: string | null;
  /** True ⇒ caller should call provider.resolveVideoPostId and persist the result. */
  needsResolve: boolean;
}

/** A composite Facebook post id is "{pageId}_{postId}" — both halves non-empty. */
function isComposite(id: string): boolean {
  const parts = id.split("_");
  return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0;
}

export function planFacebookAnalyticsId(input: FacebookAnalyticsIdInput): FacebookAnalyticsIdPlan {
  const published = (input.publishedId ?? "").trim();
  if (!published) return { analyticsId: null, needsResolve: false };

  // Instagram media ids are bare by design and are NOT Video nodes; resolving them
  // would be meaningless and would waste a call on every sync.
  if (input.platform !== "FACEBOOK") return { analyticsId: published, needsResolve: false };

  // Already a post node — the commonest case, and it must stay call-free.
  if (isComposite(published)) return { analyticsId: published, needsResolve: false };

  // A stored value is only usable if it is itself composite. A blank or malformed
  // one would otherwise send us back to the Video node under a different name and
  // silently yield EMPTY200 forever.
  const stored = (input.resolvedPostId ?? "").trim();
  if (stored && isComposite(stored)) return { analyticsId: stored, needsResolve: false };

  return { analyticsId: null, needsResolve: true };
}
