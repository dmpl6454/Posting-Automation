/**
 * Static per-platform metric-capability map — the honesty metadata the UI needs,
 * derived from the platform alone (every channel's posts share one platform, so
 * these are channel-level constants). Mirrors what each provider's
 * getPostAnalytics declares (likeKind / reachIsDistinct / metricsAvailable).
 *
 * A channel-level derivation is more robust than aggregating snapshot JSON
 * across many targets, and keeps perChannelStats/groupStats free of JSON reads.
 */
export type LikeKind = "likes" | "reactions" | "saves" | "upvotes";

export interface PlatformMetricCapabilities {
  /** What the "Likes" column actually holds for this platform. */
  likeKind: LikeKind;
  /** false ⇒ reach is aliased from impressions/views (UI renders "—"). */
  reachIsDistinct: boolean;
  /** Slots this platform NEVER populates (UI renders "—", not 0). */
  unavailable: Array<
    "impressions" | "reach" | "likes" | "comments" | "shares" | "clicks" | "views"
  >;
}

const DEFAULT_CAPS: PlatformMetricCapabilities = {
  likeKind: "likes",
  reachIsDistinct: false,
  // `views` is opt-in: a platform must be known to report a view count. The
  // default-unavailable direction is the honest one — an unlisted platform
  // renders "—" rather than a fabricated 0.
  unavailable: ["views"],
};

const CAPS: Record<string, PlatformMetricCapabilities> = {
  // FB: the ORIGINAL `post_impressions*` / `post_reach` metric NAMES are dead
  // (#100 for admin AND external tokens alike). ⚠️ But the CAPABILITY is not —
  // Meta RENAMED them, and `post_media_view` / `post_total_media_view_unique`
  // answer today on already-approved scopes. This array stays as it is precisely
  // because capability is widened per-capture, never by editing the static map.
  //
  // ⚠️ FACEBOOK is the ONLY platform where impressions and views are genuinely
  // different numbers: `post_media_view` counts renders/plays, `post_video_views`
  // counts qualified views. Measured on one reel: 5,063 vs 1,468 (3.45x). Both
  // columns are therefore meaningful and both stay available.
  // `unavailable` keeps ["impressions","reach"] BYTE-IDENTICAL — capability is
  // widened only by per-capture `metricsAvailable` (editing this array was PR
  // #148's mistake), so legacy metadata-less captures still fall back correctly.
  FACEBOOK: {
    likeKind: "reactions",
    reachIsDistinct: true,
    unavailable: ["impressions", "reach"],
  },
  // ⚠️ These five have NO impressions metric. Their providers have always stored
  // a VIEWS number in the `impressions` slot, so the column was mislabelled:
  //   INSTAGRAM  Meta's `views` (the `impressions` metric was DELETED in v22.0)
  //   YOUTUBE    statistics.viewCount — Data API v3 exposes no impressions
  //   THREADS    `views`
  //   DEVTO      page_views_count
  //   REDDIT     view_count
  // They now populate BOTH fields with that number and declare impressions
  // unavailable, so the UI shows one honest "Views" column instead of two
  // identical ones. The stored `impressions` value is retained (not moved) so the
  // engagement-rate denominator and every historical row keep working unchanged.
  INSTAGRAM: { likeKind: "likes", reachIsDistinct: true, unavailable: ["clicks", "impressions"] },
  YOUTUBE: {
    likeKind: "likes",
    reachIsDistinct: false,
    unavailable: ["reach", "clicks", "shares", "impressions"],
  },
  THREADS: { likeKind: "likes", reachIsDistinct: false, unavailable: ["reach", "clicks", "impressions"] },
  REDDIT: { likeKind: "upvotes", reachIsDistinct: false, unavailable: ["reach", "clicks", "impressions"] },
  DEVTO: {
    likeKind: "likes",
    reachIsDistinct: false,
    unavailable: ["reach", "clicks", "shares", "impressions"],
  },
  // Genuine impressions metrics, no view count exposed at all.
  LINKEDIN: { likeKind: "likes", reachIsDistinct: true, unavailable: ["views"] },
  TWITTER: { likeKind: "likes", reachIsDistinct: false, unavailable: ["reach", "clicks", "views"] },
  PINTEREST: {
    likeKind: "saves",
    reachIsDistinct: false,
    unavailable: ["reach", "comments", "shares", "views"],
  },
  SNAPCHAT: {
    likeKind: "likes",
    reachIsDistinct: false,
    unavailable: ["reach", "clicks", "likes", "views"],
  },
};

/** Platforms with no analytics API at all — every metric renders "—". */
export const NO_ANALYTICS_PLATFORMS = new Set([
  "BLUESKY",
  "DISCORD",
  "MASTODON",
  "MEDIUM",
  "SLACK",
  "TELEGRAM",
  "TIKTOK",
  "WORDPRESS",
]);

export function platformMetricCapabilities(platform: string): PlatformMetricCapabilities {
  const key = String(platform ?? "").toUpperCase();
  if (NO_ANALYTICS_PLATFORMS.has(key)) {
    return {
      likeKind: "likes",
      reachIsDistinct: false,
      unavailable: ["impressions", "reach", "views", "likes", "comments", "shares", "clicks"],
    };
  }
  return CAPS[key] ?? DEFAULT_CAPS;
}

export type MetricKey =
  | "impressions"
  | "reach"
  | "views"
  | "likes"
  | "comments"
  | "shares"
  | "clicks";

/**
 * Metrics that a capture must declare EXPLICITLY before we will believe its value —
 * because they come from a DIFFERENT platform call than their siblings and can fail
 * independently.
 *
 * The general honesty rule is "this capture declared some keys, so an omitted key must
 * have worked". That is sound only when every metric arrived on one call. On Facebook it
 * does not: `clicks`/`likes` come from the post-INSIGHTS edge, while `shares` comes from
 * the post-FIELDS edge (which additionally needs `pages_read_user_content`). The insights
 * call can succeed — declaring clicks/likes — while the fields call silently fails,
 * leaving `shares` omitted and stored as 0. The generic rule then published that as a
 * confident "0 shares".
 *
 * Measured on prod 2026-08-07: 12 FACEBOOK snapshots had the `shares` key omitted AND
 * shares = 0. Users reported this as "shares are not working / not visible". Graph also
 * OMITS the `shares` field for a post with genuinely zero shares, so "0 shares" and "we
 * could not read shares" are indistinguishable in storage — "—" is the only honest render
 * for a capture that never declared it.
 *
 * Captures written after the provider fix always declare `shares`, so this only affects
 * pre-fix rows and self-heals on the next capture.
 */
const REQUIRES_EXPLICIT_DECLARATION: Record<string, ReadonlySet<MetricKey>> = {
  FACEBOOK: new Set<MetricKey>(["shares"]),
};

/** True when this platform/metric may NOT inherit availability from sibling keys. */
export function requiresExplicitDeclaration(platform: string, key: MetricKey): boolean {
  return REQUIRES_EXPLICIT_DECLARATION[String(platform ?? "").toUpperCase()]?.has(key) ?? false;
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

/** Static-map verdict for one metric, folding in the aliased-reach rule. */
function staticallyUnavailable(key: MetricKey, caps: PlatformMetricCapabilities): boolean {
  if (key === "reach") return caps.unavailable.includes("reach") || caps.reachIsDistinct === false;
  return caps.unavailable.includes(key);
}

/**
 * Which metrics ANY of these platforms can ever report.
 *
 * Drives column/tile hiding: a metric no connected platform can report is not a
 * "0" and not even a "—" worth a column — it is dead screen furniture. For an
 * org with only Facebook channels, Impressions and Reach can NEVER be populated
 * (Meta deleted those Page-post metrics — re-verified 2026-08-06 WITH
 * `read_insights` granted), so rendering the columns at all just invites the
 * reasonable-but-wrong conclusion that the product is broken.
 *
 * Deliberately computed from PLATFORM CAPABILITY, not from "are all the current
 * values null?" — an all-null column can simply mean "nothing has synced yet",
 * and hiding it then would erase a column that is about to fill in.
 *
 * `declaredPerPlatform` lets a per-capture override widen the result: a Facebook
 * channel that posted a VIDEO does report views (via `video_insights` → the
 * impressions slot), so Impressions must stay visible for that org.
 */
export function reportableMetrics(
  platforms: Iterable<string>,
  declaredAvailable?: Iterable<Partial<Record<MetricKey, boolean>> | undefined>
): MetricKey[] {
  const reportable = new Set<MetricKey>();
  for (const platform of platforms) {
    const caps = platformMetricCapabilities(platform);
    for (const key of ALL_METRIC_KEYS) {
      if (!staticallyUnavailable(key, caps)) reportable.add(key);
    }
  }
  // A capture that actually returned a metric proves the platform CAN report it
  // for at least some post type, even when the static default says otherwise.
  for (const declared of declaredAvailable ?? []) {
    if (!declared) continue;
    for (const key of ALL_METRIC_KEYS) {
      if (declared[key] === true) reportable.add(key);
    }
  }
  return ALL_METRIC_KEYS.filter((k) => reportable.has(k));
}

/**
 * Channel-level equivalent of gatePostReportRow's per-snapshot override, for the
 * AGGREGATE read paths (perChannelStats → Channel Performance table, groupStats →
 * Group Performance card).
 *
 * ⚠️ Why this is needed — the other half of the PR #148 regression.
 * The static map is a platform-wide constant, but Facebook's capability varies
 * PER POST: a FEED post genuinely has no impressions/reach (Meta deleted those
 * insight metrics — re-verified 2026-08-06 with `read_insights` GRANTED, so no
 * permission will ever restore them), while a VIDEO/REEL post returns REAL view
 * counts through `video_insights` (mapped onto the impressions slot) or the reel
 * scraper. Marking FACEBOOK impressions+reach unavailable in the static map alone
 * therefore hid real, successfully-captured video views behind "—".
 *
 * gatePostReportRow was fixed for Reports/CSV/email in 2026-07-27, but the
 * aggregates kept consulting the static map ONLY — so the same data showed as a
 * number in Reports and as "—" in Channel Performance on the same page.
 *
 * Precedence mirrors gatePostReportRow exactly:
 *   some capture reported the metric        ⇒ available (show the sum)
 *   every capture declared it unavailable   ⇒ "—"
 *   a legacy capture carries no claim       ⇒ fall back to the static map
 *
 * Returns the EFFECTIVE unavailable list, i.e. the same shape the UI's
 * metricCellValue already consumes — so no UI change is required to benefit.
 */
export function effectiveChannelUnavailable(
  platform: string,
  declaredAvailable: Partial<Record<MetricKey, boolean>> | undefined,
  hasLegacySnapshot: boolean | undefined
): MetricKey[] {
  const caps = platformMetricCapabilities(platform);
  return ALL_METRIC_KEYS.filter((key) => {
    // A capture actually reported this metric ⇒ the data is real, show it.
    if (declaredAvailable?.[key] === true) return false;
    //
    // ⚠️ Do NOT apply requiresExplicitDeclaration here. It is a PER-ROW rule and is
    // semantically wrong on an AGGREGATE.
    //
    // `declaredAvailable` arrives as a BOOL_OR across EVERY capture on the channel, i.e.
    // it already answers "did ANY capture report this metric?". A channel mixing one old
    // app-published snapshot (which omitted `shares`) with hundreds of fresh captures
    // (which declare `shares: true`) collapses to `shares: undefined` only when NOTHING
    // reported it — so an undefined here is genuinely "no evidence", not "one call
    // failed". Applying the per-row rule blanked the Shares column for the WHOLE channel
    // and hid thousands of real, successfully-captured shares (observed in prod
    // 2026-08-07: every FB row rendered "—" while metricsAvailable held shares:true).
    //
    // gatePostReportRow keeps the per-row rule, which is where it belongs: there,
    // `metricsAvailable` describes ONE capture, so an omitted key really does mean that
    // capture's fields call never resolved.
    //
    // ⚠️ `views` is EXEMPT from the legacy fallback.
    //
    // That fallback exists because a metadata-less capture makes no METADATA
    // claim, so the static map is the best available evidence. But views
    // availability is not metadata-derived at all — it comes from the column
    // itself (`BOOL_OR(views IS NOT NULL)` in fetchChannelStatRows). A `false`
    // there is therefore definitive: no capture on this channel ever stored a
    // view count. Letting one legacy row override that renders a confident
    // "Views 0" for a channel with no views data at all.
    if (key === "views" && declaredAvailable?.views === false) return true;
    // No capture claimed it, but some capture predates the metadata ⇒ static map.
    if (hasLegacySnapshot) return staticallyUnavailable(key, caps);
    // Every capture explicitly declared it unavailable (or there are no captures
    // at all, in which case hasSnapshot=false already renders "—").
    if (declaredAvailable?.[key] === false) return true;
    return staticallyUnavailable(key, caps);
  });
}

