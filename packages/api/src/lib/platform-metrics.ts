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
  FACEBOOK: { likeKind: "reactions", reachIsDistinct: true, unavailable: [] },
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
