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
