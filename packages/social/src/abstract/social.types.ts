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
 * One post that exists ON THE PLATFORM, as returned by a listing edge — whether or
 * not we published it. Metrics are deliberately ABSENT here: listing and metric
 * capture are separate calls with separate permissions and separate failure modes,
 * and conflating them is how a listing success would end up storing fake zero
 * metrics. The sync worker lists first, then captures metrics per post.
 */
export interface ExternalPostSummary {
  /** Platform-native id. FB: composite "{pageId}_{postId}". IG: bare media id. */
  platformPostId: string;
  publishedAt: Date;
  permalink?: string;
  message?: string;
  /** FB attachment media_type (photo/video/album/share). */
  mediaType?: string;
  /** IG media_product_type (FEED/REELS/STORY) — selects the metric set. */
  productType?: string;
  /**
   * FB: the Video/Reel node id behind a video attachment
   * (`attachments.target.id`), resolved for free during listing.
   *
   * Used to recover a view count from the Video node when the post node does
   * not supply one.
   *
   * ⚠️ CORRECTION 2026-08-12 — the previous note here claimed the feed-post
   * insights edge "returns post_video_views = 0 for every video (measured
   * 40/40)". That is REFUTED by live probing: `post_video_views` returns a real
   * `period=lifetime` value (1,468 on reel 596165523816494_1604103394609115)
   * AND a trailing `period=day` row valued 0. The 40/40 zero was the last-wins
   * parse reading that trailing row — the same fake-zero trap `selectLifetimeRow`
   * was later written to defeat. Do not restore the old claim; it is what kept
   * a working metric from ever being wired up.
   */
  videoId?: string;
  /** FB: true when the attachment target URL is a /reel/ permalink. */
  isReel?: boolean;
}

export interface ExternalPostPage {
  posts: ExternalPostSummary[];
  /** Opaque cursor for the next page; absent ⇒ no more pages. */
  nextCursor?: string;
  /** Present only when the listing was degraded (dead token / missing scope). */
  degraded?: AnalyticsDegradation;
}

export interface ListPostsOptions {
  /** Only posts published at or after this instant. */
  since: Date;
  /** Resume token from a previous ExternalPostPage. */
  cursor?: string;
  /** Page size. Kept small by default — the box, not Meta, is the constraint. */
  limit?: number;
}

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
  /**
   * The app no longer holds access to THIS specific Page/account, while the same
   * user's other pages keep working (Meta #190 subcode 492). Distinct from
   * `token_invalid` because the credential is fine — the grant for one page is
   * gone, either because the page was left unticked in a later consent or because
   * the person's role on it changed. Live-verified 2026-08-12: the user token was
   * `is_valid: true` with all 12 scopes and 72 working pages, while one page
   * returned 492. Telling that user "your access token was rejected" is false and
   * sends them chasing the wrong fix.
   */
  | "page_access_lost"
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
  /**
   * True only when a scrape was ACTUALLY executed for this capture.
   *
   * ⚠️ Load-bearing for the external-sync circuit breaker. That breaker counts
   * "misses" to detect a soft IP ban, and it used to infer a miss from
   * `source !== "scrape"` — which is ALSO what a clean API success looks like.
   * When the media-view metrics went live on 2026-08-11 the provider began
   * returning early with `source: "api"` on the happy path, so five consecutive
   * SUCCESSES tripped the breaker and every remaining reel in the account was
   * skipped. Scrape-sourced captures fell 1,824/h → 0 within the hour and the FB
   * reel backlog grew to 94.3% unmeasured.
   *
   * Distinguishing "did not need to scrape" from "scraped and got nothing" is
   * the whole point — never re-derive it from `source`.
   */
  scrapeAttempted?: boolean;
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
