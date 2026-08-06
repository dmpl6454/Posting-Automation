export interface SocialPostPayload {
  content: string;
  mediaUrls?: string[];
  mediaTypes?: string[]; // MIME types corresponding to mediaUrls, e.g. ["video/mp4"]
  metadata?: Record<string, unknown>;
  /** Optional progress callback — called with 0–100 during media upload phases */
  onProgress?: (percent: number) => void | Promise<void>;
}

export interface SocialPostResult {
  platformPostId: string;
  url: string;
  metadata?: Record<string, unknown>;
}

export type LikeKind = "likes" | "reactions" | "saves" | "upvotes";
export type AnalyticsSource = "api" | "scrape";

/**
 * Why a capture came back short of the platform's full metric set. Distinguishes
 * "the owner must reconnect to grant a scope" from "this platform genuinely has
 * no such metric" — the two look identical in the stored numbers (both 0), and
 * conflating them is what made a dead Meta token indistinguishable from a post
 * with genuinely zero engagement.
 *
 * VERIFIED 2026-08-06: a Meta token lacking `read_insights` gets HTTP **200 with
 * an empty `data` array** on the FB post-insights edge — a SILENT empty, not an
 * error. So a degradation reason cannot be inferred from HTTP status alone.
 */
export type AnalyticsDegradeReason =
  /** Token rejected outright (Meta #190 / session invalidated) — reconnect required. */
  | "token_invalid"
  /** Token is live but lacks a scope needed to read these metrics — reconnect required. */
  | "missing_scope"
  /** Platform accepted the call but returned no rows for reasons we can't attribute. */
  | "no_data";

export interface AnalyticsDegradation {
  reason: AnalyticsDegradeReason;
  /** Scopes the platform explicitly named as missing (e.g. ["read_insights"]). */
  missingScopes?: string[];
  /** Short, human-readable diagnosis for the UI. Never contains a token. */
  detail?: string;
}

export interface SocialAnalytics {
  impressions: number;
  clicks: number;
  likes: number;
  shares: number;
  comments: number;
  reach: number;
  engagementRate: number;
  // ── extended honesty metadata (all OPTIONAL — back-compat; providers fill
  //    only what they truly have; the worker persists these into
  //    AnalyticsSnapshot.metadata; the UI + aggregation read them) ──
  /** Saves/bookmarks (IG saved, Pinterest save) — a distinct action, not a like. */
  saved?: number;
  /** true only when `reach` is a genuinely distinct metric from `impressions`.
   *  false ⇒ reach was aliased from impressions/views (UI renders "—", not a
   *  duplicate of the Impressions column). */
  reachIsDistinct?: boolean;
  /** What the `likes` slot actually holds, for honest per-platform labeling. */
  likeKind?: LikeKind;
  /** Which of the 7 slots this platform can populate at all. A slot mapped to
   *  false ⇒ the UI renders "—" (not available on this platform), never 0. */
  metricsAvailable?: Partial<
    Record<"impressions" | "reach" | "likes" | "comments" | "shares" | "clicks", boolean>
  >;
  /** Where this row came from: official API or the scraper fallback. */
  source?: AnalyticsSource;
  /** Mean watch time in MILLISECONDS (IG Reels `ig_reels_avg_watch_time`). */
  avgWatchTimeMs?: number;
  /** Total accumulated watch time in MILLISECONDS (IG Reels). */
  totalWatchTimeMs?: number;
  /** Present only when the capture was degraded — see AnalyticsDegradation. */
  degraded?: AnalyticsDegradation;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  scopes: string[];
}

export interface SocialProfile {
  id: string;
  name: string;
  username?: string;
  avatar?: string;
}

export interface PlatformConstraints {
  maxContentLength: number;
  supportedMediaTypes: string[];
  maxMediaCount: number;
  maxMediaSize?: number; // bytes
  supportsThreads?: boolean;
  supportsScheduling?: boolean;
}
