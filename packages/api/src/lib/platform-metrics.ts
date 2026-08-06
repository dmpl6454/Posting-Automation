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
  unavailable: Array<"impressions" | "reach" | "likes" | "comments" | "shares" | "clicks">;
}

const DEFAULT_CAPS: PlatformMetricCapabilities = {
  likeKind: "likes",
  reachIsDistinct: false,
  unavailable: [],
};

const CAPS: Record<string, PlatformMetricCapabilities> = {
  // FB: Meta DELETED every post_impressions*/reach metric from the Page-post
  // insights edge (live-verified 2026-07-24: both 400 #100 for admin AND external
  // tokens — no permission restores them). The provider hardcodes impressions:0,
  // reach:0 and declares metricsAvailable:{impressions:false,reach:false}; mark
  // them unavailable HERE too so the UI renders "—" (honest) instead of a fake 0.
  FACEBOOK: { likeKind: "reactions", reachIsDistinct: true, unavailable: ["impressions", "reach"] },
  INSTAGRAM: { likeKind: "likes", reachIsDistinct: true, unavailable: ["clicks"] },
  YOUTUBE: { likeKind: "likes", reachIsDistinct: false, unavailable: ["reach", "clicks", "shares"] },
  LINKEDIN: { likeKind: "likes", reachIsDistinct: true, unavailable: [] },
  THREADS: { likeKind: "likes", reachIsDistinct: false, unavailable: ["reach", "clicks"] },
  TWITTER: { likeKind: "likes", reachIsDistinct: false, unavailable: ["reach", "clicks"] },
  PINTEREST: { likeKind: "saves", reachIsDistinct: false, unavailable: ["reach", "comments", "shares"] },
  REDDIT: { likeKind: "upvotes", reachIsDistinct: false, unavailable: ["reach", "clicks"] },
  DEVTO: { likeKind: "likes", reachIsDistinct: false, unavailable: ["reach", "clicks", "shares"] },
  SNAPCHAT: { likeKind: "likes", reachIsDistinct: false, unavailable: ["reach", "clicks", "likes"] },
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
      unavailable: ["impressions", "reach", "likes", "comments", "shares", "clicks"],
    };
  }
  return CAPS[key] ?? DEFAULT_CAPS;
}

export type MetricKey = "impressions" | "reach" | "likes" | "comments" | "shares" | "clicks";

const ALL_METRIC_KEYS: MetricKey[] = [
  "impressions",
  "reach",
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
    // No capture claimed it, but some capture predates the metadata ⇒ static map.
    if (hasLegacySnapshot) return staticallyUnavailable(key, caps);
    // Every capture explicitly declared it unavailable (or there are no captures
    // at all, in which case hasSnapshot=false already renders "—").
    if (declaredAvailable?.[key] === false) return true;
    return staticallyUnavailable(key, caps);
  });
}

