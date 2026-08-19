/**
 * Matches platform-fetched posts against posts WE published, so Insights never
 * double-counts.
 *
 * The hazard
 * ──────────
 * `published_posts` returns every post on the Page — including the ones we published.
 * If those are stored as "external" too, every app-published post is counted twice: once
 * from its PostTarget row and once from its ExternalPost row.
 *
 * The id-format problem (and why it used to be unsolvable)
 * ───────────────────────────────────────────────────────
 * `PostTarget.publishedId` holds:
 *   - "{pageId}_{postId}"  for ordinary feed publishes  -> matches the listing exactly
 *   - a BARE Video-node id for video publishes          -> matches NOTHING in the listing
 * CLAUDE.md recorded that videos "can never be id-matched" for exactly this reason.
 *
 * LIVE-VERIFIED 2026-08-06 — they can:
 *     GET /{video-id}?fields=id,post_id   ->  post_id = 122111714397390760
 *     published_posts id                  ->  1196604146874966_122111714397390760
 * `post_id` is the SECOND HALF of the composite id, so the match key is
 * `{pageId}_{post_id}`. One extra Graph call, only for bare ids, only once per target
 * (the resolved value is persisted).
 *
 * Instagram needs none of this: media ids are bare AND are the same ids publishing
 * returns, so it is an exact string match (measured: all 60 app-published IG targets
 * since 2026-08-01 carry bare media ids).
 *
 * Pure + synchronous so it is unit-testable without Prisma or network.
 */

export interface PublishedTargetLike {
  id: string;
  /** Platform id we recorded at publish time. May be composite OR a bare video id. */
  publishedId: string | null;
  /** Composite id resolved from a bare Video-node id, when we have already resolved it. */
  resolvedPostId?: string | null;
}

/** True for a Facebook id that needs Video-node resolution before it can be matched. */
export function isBareFacebookVideoId(publishedId: string): boolean {
  // Composite ids always contain "_". Anything else on FACEBOOK is a bare node id.
  return publishedId.length > 0 && !publishedId.includes("_");
}

/**
 * Build the set of platform ids that belong to posts WE published on this account.
 *
 * Every known alias for a target is included: the raw `publishedId`, any
 * `resolvedPostId` we previously computed, and — for a bare FB video id — the
 * `{pageId}_{bareId}` form, because a Page occasionally surfaces a video post under
 * that composite even without resolution.
 */
export function buildOwnedIdSet(
  targets: PublishedTargetLike[],
  pageId: string
): Set<string> {
  const owned = new Set<string>();
  for (const t of targets) {
    if (!t.publishedId) continue;
    owned.add(t.publishedId);
    if (t.resolvedPostId) owned.add(t.resolvedPostId);
    if (isBareFacebookVideoId(t.publishedId)) {
      owned.add(`${pageId}_${t.publishedId}`);
    }
  }
  return owned;
}

export interface ClassifiedPost {
  platformPostId: string;
  /** The PostTarget this platform post corresponds to, when it is one of ours. */
  postTargetId: string | null;
}

/**
 * Classify listed posts as ours (link to the PostTarget) or platform-native (null).
 *
 * ⚠️ Only posts classified as platform-native are unioned into the Insights read paths —
 * and since 2026-08-19 that union is itself OFF by default (`INSIGHTS_INCLUDE_EXTERNAL_POSTS`),
 * so in the default configuration nothing this function classifies reaches Insights at all.
 * Ours keep flowing through the existing PostTarget aggregates untouched. That is what
 * makes this change additive: if dedup somehow mis-classifies a post as OURS, we lose a
 * row (conservative). If it mis-classifies as THEIRS, we double-count (wrong). So the
 * matching is deliberately generous — every known alias is checked.
 */
export function classifyPosts(
  listed: Array<{ platformPostId: string }>,
  targets: PublishedTargetLike[],
  pageId: string
): ClassifiedPost[] {
  const byId = new Map<string, string>();
  for (const t of targets) {
    if (!t.publishedId) continue;
    byId.set(t.publishedId, t.id);
    if (t.resolvedPostId) byId.set(t.resolvedPostId, t.id);
    if (isBareFacebookVideoId(t.publishedId)) byId.set(`${pageId}_${t.publishedId}`, t.id);
  }

  return listed.map((p) => ({
    platformPostId: p.platformPostId,
    postTargetId: byId.get(p.platformPostId) ?? null,
  }));
}

/**
 * Which of our targets still need a bare-video-id -> composite-id resolution.
 * Returns at most `max` ids so one sync run cannot spend unbounded Graph calls on a
 * Page with a long tail of old videos.
 */
export function targetsNeedingVideoResolution(
  targets: PublishedTargetLike[],
  listedIds: Set<string>,
  pageId: string,
  max = 10
): PublishedTargetLike[] {
  const out: PublishedTargetLike[] = [];
  for (const t of targets) {
    if (out.length >= max) break;
    if (!t.publishedId || t.resolvedPostId) continue;
    if (!isBareFacebookVideoId(t.publishedId)) continue;
    // Already matched via the {page}_{bare} alias? Then no call is needed.
    if (listedIds.has(t.publishedId) || listedIds.has(`${pageId}_${t.publishedId}`)) continue;
    out.push(t);
  }
  return out;
}
