import type { SocialPlatform } from "@postautomation/db";
import { SocialProvider } from "../abstract/social.abstract";
import type {
  SocialPostPayload,
  SocialPostResult,
  SocialAnalytics,
  AnalyticsDegradation,
  OAuthTokens,
  OAuthConfig,
  SocialProfile,
  PlatformConstraints,
  ExternalPostPage,
  ExternalPostSummary,
  ListPostsOptions,
} from "../abstract/social.types";
import {
  diagnoseEmptyInsights,
  diagnoseMetaError,
  worstDegradation,
} from "../utils/meta-insight-diagnosis";
import { fetchT } from "../utils/fetch-timeout";
import { headRemoteMedia } from "../utils/ranged-media";
import { scrapeFacebookReelEngagement } from "@postautomation/social-scrapers";

/**
 * Videos larger than this are published via Graph's `file_url` remote-pull
 * (Facebook fetches the file from our public S3 URL itself — same public-URL
 * prerequisite as Instagram's `video_url` container), so the worker never
 * buffers a multi-GB file in RAM. Files at or below the threshold (and files
 * whose size can't be probed) keep the classic buffered multipart path
 * byte-identical. Mirrors the YouTube 64MB buffered/streamed split.
 */
export const FB_URL_PULL_MIN_BYTES = 64 * 1024 * 1024;

// ── Facebook API Usage Tracking ────────────────────────────────────────
// Facebook returns x-app-usage and x-page-usage headers as JSON:
//   { "call_count": 28, "total_cputime": 25, "total_time": 30 }
// Values are percentages — throttle when approaching 80%, pause at 95%.

interface FbUsageInfo {
  call_count: number;
  total_cputime: number;
  total_time: number;
}

const usageCache: {
  app: FbUsageInfo;
  page: Record<string, FbUsageInfo>;
  lastRequest: number;
} = {
  app: { call_count: 0, total_cputime: 0, total_time: 0 },
  page: {},
  lastRequest: 0,
};

// Minimum ms between sequential Graph API requests (soft spacing)
const MIN_REQUEST_GAP_MS = 300;

/** Per-call knobs for graphFetch. Defaults preserve the worker/publish-path
 *  behavior EXACTLY (unbounded sleeps, 3 retries, no fetch timeout). Only the
 *  OAuth CONNECT path (running inside the web callback's 120s nginx budget)
 *  passes clamped values — a hung/throttled Graph API must fail fast there
 *  instead of burning the one-shot consent code. */
interface GraphFetchOpts {
  /** Cap on any single throttle/backoff sleep. Default: uncapped (60s pause, 30-120s backoff). */
  maxSleepMs?: number;
  /** Rate-limit retry budget. Default: 3. */
  retries?: number;
  /** Per-request fetch timeout (AbortSignal.timeout). Default: none (bare fetch). */
  timeoutMs?: number;
}

/** Clamp used by connect-path callers (exchange/profile/pages). */
const CONNECT_GRAPH_OPTS: GraphFetchOpts = {
  maxSleepMs: 5_000,
  retries: 1,
  timeoutMs: 25_000,
};

/** Max pagination pages fetched during connect (~500 Pages at limit=25). */
const MAX_CONNECT_PAGINATION_PAGES = 20;

export class FacebookProvider extends SocialProvider {
  readonly platform: SocialPlatform = "FACEBOOK";
  readonly displayName = "Facebook";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 63206,
    supportedMediaTypes: ["image/jpeg", "image/png", "image/gif", "video/mp4"],
    maxMediaCount: 10,
    maxMediaSize: 10 * 1024 * 1024,
  };

  private readonly apiVersion = "v18.0";
  private readonly graphBaseUrl = "https://graph.facebook.com";

  // ── Rate-limit-aware fetch wrapper ───────────────────────────────────
  // Tracks usage headers, enforces spacing, auto-retries on 429/throttle.

  private async graphFetch(
    url: string,
    init: RequestInit = {},
    pageId?: string,
    opts: GraphFetchOpts = {}
  ): Promise<Response> {
    const retries = opts.retries ?? 3;

    // Enforce minimum gap between requests
    const now = Date.now();
    const elapsed = now - usageCache.lastRequest;
    if (elapsed < MIN_REQUEST_GAP_MS) {
      await this.sleep(MIN_REQUEST_GAP_MS - elapsed);
    }

    // Pre-flight: if usage is high, add a proportional delay
    await this.throttleIfNeeded(pageId, opts.maxSleepMs);

    usageCache.lastRequest = Date.now();
    const res = opts.timeoutMs != null
      ? await fetchT(url, init, opts.timeoutMs)
      : await fetch(url, init);

    // Parse and cache usage headers
    this.parseUsageHeaders(res, pageId);

    // Auto-retry on rate limit (HTTP 429 or Facebook error code 4/32/368)
    if ((res.status === 429 || res.status === 403) && retries > 0) {
      const body: any = await res.clone().json().catch(() => null);
      const errCode = body?.error?.code;
      if (res.status === 429 || errCode === 4 || errCode === 32 || errCode === 368) {
        const backoff = this.clampSleep(this.calculateBackoff(retries), opts.maxSleepMs);
        console.log(`[Facebook] Rate limited (code=${errCode || res.status}), backing off ${backoff}ms (${retries} retries left)`);
        await this.sleep(backoff);
        return this.graphFetch(url, init, pageId, { ...opts, retries: retries - 1 });
      }
    }

    return res;
  }

  private parseUsageHeaders(res: Response, pageId?: string): void {
    try {
      const appUsage = res.headers.get("x-app-usage");
      if (appUsage) {
        usageCache.app = JSON.parse(appUsage);
      }
      const pageUsage = res.headers.get("x-page-usage");
      if (pageUsage && pageId) {
        usageCache.page[pageId] = JSON.parse(pageUsage);
      }
    } catch { /* ignore parse errors */ }
  }

  private getMaxUsage(pageId?: string): number {
    const appMax = Math.max(usageCache.app.call_count, usageCache.app.total_cputime, usageCache.app.total_time);
    const pageMax = pageId && usageCache.page[pageId]
      ? Math.max(usageCache.page[pageId].call_count, usageCache.page[pageId].total_cputime, usageCache.page[pageId].total_time)
      : 0;
    return Math.max(appMax, pageMax);
  }

  private async throttleIfNeeded(pageId?: string, maxSleepMs?: number): Promise<void> {
    const usage = this.getMaxUsage(pageId);

    if (usage >= 95) {
      // Critical — pause 60s to let the window reset (clamped on connect path)
      const delay = this.clampSleep(60_000, maxSleepMs);
      console.log(`[Facebook] Usage at ${usage}% — pausing ${delay}ms to avoid hard block`);
      await this.sleep(delay);
    } else if (usage >= 80) {
      // High — add proportional delay (2-10s)
      const delay = this.clampSleep(Math.round(((usage - 80) / 15) * 8_000 + 2_000), maxSleepMs);
      console.log(`[Facebook] Usage at ${usage}% — throttling ${delay}ms`);
      await this.sleep(delay);
    } else if (usage >= 60) {
      // Moderate — small delay (500-2000ms)
      const delay = this.clampSleep(Math.round(((usage - 60) / 20) * 1_500 + 500), maxSleepMs);
      await this.sleep(delay);
    }
    // Below 60% — no throttle, just the MIN_REQUEST_GAP_MS spacing
  }

  /** Clamp a sleep to maxSleepMs when provided; undefined = today's exact behavior. */
  private clampSleep(ms: number, maxSleepMs?: number): number {
    return maxSleepMs != null ? Math.min(ms, maxSleepMs) : ms;
  }

  private calculateBackoff(retriesLeft: number): number {
    // Exponential backoff: 30s, 60s, 120s (based on retries remaining)
    const attempt = 4 - retriesLeft;
    return Math.min(30_000 * Math.pow(2, attempt - 1), 120_000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── OAuth ────────────────────────────────────────────────────────────

  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      scope: config.scopes.join(","),
      state,
      response_type: "code",
      // Force Facebook to RE-PRESENT the permission + Page-selection wizard
      // instead of the "Continue as … / use previous settings" returning-user
      // shortcut. Without this, a user who connected before (or who tapped
      // "Continue" on a prior grant that selected 0 Pages) silently re-uses that
      // empty grant → me/accounts returns [] → the confusing fb_no_pages toast
      // even though they DO admin a Page. `rerequest` makes them re-pick a Page.
      auth_type: "rerequest",
    });
    return `https://www.facebook.com/${this.apiVersion}/dialog/oauth?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    const params = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.callbackUrl,
      code,
    });

    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/oauth/access_token?${params.toString()}`,
      {},
      undefined,
      CONNECT_GRAPH_OPTS
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Facebook token exchange failed: ${JSON.stringify(data)}`);

    const longLivedTokens = await this.exchangeForLongLivedToken(
      data.access_token,
      config.clientId,
      config.clientSecret
    );

    return longLivedTokens;
  }

  async refreshAccessToken(_refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    const longLivedTokens = await this.exchangeForLongLivedToken(
      _refreshToken,
      config.clientId,
      config.clientSecret
    );

    return longLivedTokens;
  }

  // ── Publishing ───────────────────────────────────────────────────────

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const pageId = (payload.metadata?.pageId as string) || (payload.metadata?.platformId as string) || "me";

    if (payload.mediaUrls?.length) {
      return this.publishPostWithMedia(tokens, payload, pageId);
    }

    // Text-only post
    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${pageId}/feed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: payload.content,
          access_token: tokens.accessToken,
        }),
      },
      pageId
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Facebook post failed: ${JSON.stringify(data)}`);

    return {
      platformPostId: data.id,
      url: `https://www.facebook.com/${data.id.replace("_", "/posts/")}`,
      metadata: data,
    };
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}?access_token=${tokens.accessToken}`,
      { method: "DELETE" }
    );

    if (!res.ok) {
      const data: any = await res.json();
      throw new Error(`Facebook delete failed: ${JSON.stringify(data)}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/me?fields=id,name,picture&access_token=${tokens.accessToken}`,
      {},
      undefined,
      CONNECT_GRAPH_OPTS
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Facebook profile fetch failed: ${JSON.stringify(data)}`);

    return {
      id: data.id,
      name: data.name,
      avatar: data.picture?.data?.url,
    };
  }

  async getPages(tokens: OAuthTokens): Promise<Array<{
    id: string;
    name: string;
    avatar?: string;
    accessToken: string;
  }>> {
    const pages: Array<{ id: string; name: string; avatar?: string; accessToken: string }> = [];
    let url: string | null = `${this.graphBaseUrl}/${this.apiVersion}/me/accounts?fields=id,name,access_token,picture{url}&limit=25&access_token=${tokens.accessToken}`;
    let pageCount = 0;

    while (url) {
      if (pageCount >= MAX_CONNECT_PAGINATION_PAGES) {
        console.warn(`[Facebook] getPages: pagination capped at ${MAX_CONNECT_PAGINATION_PAGES} pages (${pages.length} Pages loaded) — truncating`);
        break;
      }
      pageCount++;

      const res = await this.graphFetch(url, {}, undefined, CONNECT_GRAPH_OPTS);
      const data: any = await res.json();
      if (!res.ok) throw new Error(`Facebook pages fetch failed: ${JSON.stringify(data)}`);

      if (data.data) {
        for (const page of data.data) {
          pages.push({
            id: page.id,
            name: page.name,
            avatar: page.picture?.data?.url ?? undefined,
            accessToken: page.access_token,
          });
        }
      }

      url = data.paging?.next || null;
    }

    return pages;
  }

  /**
   * List posts the PAGE published — including ones made directly on Facebook, which
   * Insights could never see before. LIVE-VERIFIED 2026-08-06 against production:
   *
   *   GET /{page-id}/published_posts
   *       ?fields=id,created_time,message,status_type,permalink_url,attachments{media_type}
   *       &since=<unix>&limit=25
   *   -> HTTP 200, paging.cursors present, ids in composite "{pageId}_{postId}" form.
   *
   * Measured on the `Bollywood` Page: 7 posts since 2026-08-01, of which 6 were ours and
   * 1 was posted directly — exactly the gap this feature exists to close.
   *
   * ⚠️ `published_posts`, NOT `/feed`. Both respond, but `/feed` also admits visitor
   * posts and other non-Page-authored content, which is not "this Page's posts".
   *
   * ⚠️ Metrics are deliberately NOT fetched here. Listing and metric capture have
   * different permissions and different failure modes; fusing them is how a successful
   * listing would end up persisting fake-zero metrics for posts whose insights call was
   * refused. The caller fetches metrics per post via getPostAnalytics.
   */
  async listRecentPosts(
    tokens: OAuthTokens,
    pageId: string,
    opts: ListPostsOptions
  ): Promise<ExternalPostPage> {
    const since = Math.floor(opts.since.getTime() / 1000);
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const cursor = opts.cursor ? `&after=${encodeURIComponent(opts.cursor)}` : "";

    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${pageId}/published_posts` +
        `?fields=id,created_time,message,status_type,permalink_url,attachments{media_type}` +
        `&since=${since}&limit=${limit}${cursor}&access_token=${tokens.accessToken}`,
      {},
      pageId
    );
    const data: any = await res.json().catch(() => ({}));

    if (!res.ok) {
      // A dead token (190/460 — the dominant failure: measured, only ~23% of Pages are
      // reachable) must surface as a DEGRADATION, never as "this Page has no posts".
      console.warn(`[Facebook] listRecentPosts failed for page ${pageId}: ${JSON.stringify(data?.error ?? data).slice(0, 300)}`);
      return { posts: [], degraded: diagnoseMetaError(data?.error) };
    }

    const posts: ExternalPostSummary[] = [];
    for (const row of Array.isArray(data?.data) ? data.data : []) {
      if (!row?.id || !row?.created_time) continue;
      const when = new Date(row.created_time);
      if (Number.isNaN(when.getTime())) continue;
      posts.push({
        platformPostId: String(row.id),
        publishedAt: when,
        ...(row.permalink_url ? { permalink: String(row.permalink_url) } : {}),
        ...(row.message ? { message: String(row.message).slice(0, 2000) } : {}),
        // attachments.media_type is the reliable photo/video/album discriminator;
        // status_type is a weaker fallback ("added_photos", "added_video", …).
        ...(row.attachments?.data?.[0]?.media_type
          ? { mediaType: String(row.attachments.data[0].media_type) }
          : row.status_type
            ? { mediaType: String(row.status_type) }
            : {}),
      });
    }

    return {
      posts,
      ...(data?.paging?.cursors?.after && data?.paging?.next
        ? { nextCursor: String(data.paging.cursors.after) }
        : {}),
    };
  }

  /**
   * Resolve a BARE Video-node id to the composite feed-post id that
   * `published_posts` returns — the long-missing half of FB dedup.
   *
   * LIVE-VERIFIED 2026-08-06:
   *   GET /{video-id}?fields=id,post_id  ->  post_id=122111714397390760
   *   published_posts id                 ->  1196604146874966_122111714397390760
   * i.e. `post_id` is the SECOND HALF of the composite id, so the match key is
   * `{pageId}_{post_id}`.
   *
   * This matters because video publishes store a bare Video-node id in
   * PostTarget.publishedId while every other path stores "{page}_{post}" — which is why
   * CLAUDE.md recorded that videos "can never be id-matched". They can now.
   *
   * Returns null when the video no longer exists (a deleted video 400s — verified with
   * id 1748002179986936, which CLAUDE.md independently records as deleted).
   */
  async resolveVideoPostId(
    tokens: OAuthTokens,
    videoId: string,
    pageId: string
  ): Promise<string | null> {
    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${videoId}?fields=id,post_id&access_token=${tokens.accessToken}`,
      {},
      pageId
    );
    if (!res.ok) return null;
    const data: any = await res.json().catch(() => ({}));
    const postId = data?.post_id;
    return postId ? `${pageId}_${postId}` : null;
  }

  async getPostAnalytics(tokens: OAuthTokens, platformPostId: string): Promise<SocialAnalytics | null> {
    // Video posts store a BARE Video node id (the {page}/videos edge returns
    // only {id} — no post_id), while every other path stores "{page}_{post}".
    // Post-node insights/fields are invalid on a Video node (the calls error
    // and this function returned null forever), so route bare ids to the
    // Video-node analytics endpoints instead.
    if (!platformPostId.includes("_")) {
      return this.getVideoAnalytics(tokens, platformPostId);
    }

    // Metric-source strategy — re-verified live 2026-08-06 with a token that HAS
    // the newly-approved `read_insights` + `pages_read_user_content` granted:
    //  - Meta DELETED all post_impressions*/post_engaged_users/post_reach/post_views
    //    metrics. They return #100 "must be a valid insights metric" EVEN WITH
    //    read_insights granted, while post_clicks on the SAME token returns a real
    //    row — proving the deletion is platform-level, not permission-gated.
    //    → impressions/reach are permanently "—". Do NOT re-add those names.
    //  - clicks + REACTIONS come from the INSIGHTS edge and need `read_insights`.
    //  - comments have NO insights equivalent; the fields API (comments.summary)
    //    needs `pages_read_user_content`. So the fields fetch is BEST-EFFORT
    //    (never fatal), and comments render "—" when it fails.
    //
    // ⚠️ Missing `read_insights` is a SILENT EMPTY, not an error: the call returns
    // HTTP 200 with `{"data":[]}`. Before this was handled, that empty array was
    // read as "every metric is zero" and stored as a confident 0 — a dead/
    // under-scoped token was indistinguishable from a post with no engagement.
    // post_clicks and post_reactions_by_type_total both return a row even on a
    // zero-engagement post (verified), so they are reliable SENTINELS: 200 with
    // zero rows ⇒ the scope is missing.
    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}/insights?metric=post_clicks,post_video_views,post_reactions_by_type_total&access_token=${tokens.accessToken}`
    );

    const data: any = await res.json();
    if (!res.ok) {
      console.warn(`[Facebook] getPostAnalytics insights failed for ${platformPostId}: ${JSON.stringify(data)}`);
    }

    const metrics: Record<string, number> = {};
    const rows: any[] = Array.isArray(data?.data) ? data.data : [];
    for (const metric of rows) {
      // post_reactions_by_type_total is an OBJECT {like:N,love:N,...}; sum it.
      const v = metric.values?.[0]?.value;
      metrics[metric.name] =
        v && typeof v === "object"
          ? Object.values(v).reduce((s: number, n: any) => s + (Number(n) || 0), 0)
          : v || 0;
    }

    // Insights are usable only when the call succeeded AND carried rows (the
    // sentinel rule above). `post_clicks` present is the positive proof.
    const insightsDegradation = res.ok
      ? diagnoseEmptyInsights(rows.length, true, "read_insights")
      : diagnoseMetaError(data?.error);
    const insightsUsable = res.ok && rows.length > 0;
    const reactionsFromInsights = insightsUsable ? metrics.post_reactions_by_type_total ?? null : null;

    // Best-effort post FIELDS (shares resolves on a basic Page token;
    // reactions/comments need pages_read_user_content). NEVER fatal.
    let fieldsReactions: number | null = null;
    let comments: number | null = null;
    // null (not 0) until a call actually resolves it. A post with no shares and
    // a post whose shares we were never allowed to read are different facts, and
    // storing 0 for the second is the silent-zero bug this subsystem exists to
    // prevent (measured: 26 prod captures stored shares:0 from a failed fetch).
    let shares: number | null = null;
    let fieldsDegradation: AnalyticsDegradation | undefined;
    const postRes = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}?fields=shares,comments.summary(true),reactions.summary(true)&access_token=${tokens.accessToken}`
    );
    const postData: any = await postRes.json();
    if (postRes.ok) {
      // `shares` is OMITTED by Graph for a post with zero shares, so an ok
      // response with no `shares` key is a real 0 — not an unknown.
      shares = postData.shares?.count ?? 0;
      comments = postData.comments?.summary?.total_count ?? null;
      fieldsReactions = postData.reactions?.summary?.total_count ?? null;
    } else {
      console.warn(`[Facebook] post fields fetch failed (likely missing pages_read_user_content) for ${platformPostId}: ${JSON.stringify(postData)}`);
      fieldsDegradation = diagnoseMetaError(postData?.error);
      // shares alone often still resolves — try it in isolation (basic page token).
      const sRes = await this.graphFetch(
        `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}?fields=shares&access_token=${tokens.accessToken}`
      );
      if (sRes.ok) shares = ((await sRes.json()) as any)?.shares?.count ?? 0;
    }

    // Prefer the fields reaction count (all reaction types) when available; else
    // fall back to the insights reaction total.
    const reactions = fieldsReactions ?? reactionsFromInsights;
    const commentsAvailable = comments !== null;
    // Reactions are only real if SOME source produced them. When both the fields
    // API and the insights edge are permission-blocked, a 0 here would be a lie.
    const reactionsAvailable = reactions !== null;

    return {
      impressions: 0,
      clicks: insightsUsable ? metrics.post_clicks || 0 : 0,
      likes: reactions ?? 0,
      shares: shares ?? 0,
      comments: comments ?? 0,
      reach: 0,
      // No impressions ⇒ no meaningful rate. Reports recomputes engagement as
      // (likes+comments+shares)/impressions, which correctly yields "—" for FB.
      engagementRate: 0,
      // impressions/reach: deleted by Meta (permanent). clicks: needs
      // read_insights. comments/likes: need pages_read_user_content (or the
      // insights reaction fallback). Anything false renders "—", never a fake 0.
      //
      // ⚠️ `shares` MUST be declared. An OMITTED key reads as "available" in
      // gatePostReportRow/effectiveChannelUnavailable ("metadata present and the
      // key not false ⇒ trust the value"), so leaving it out published a failed
      // fetch as a confident 0.
      metricsAvailable: {
        impressions: false,
        reach: false,
        clicks: insightsUsable,
        comments: commentsAvailable,
        likes: reactionsAvailable,
        shares: shares !== null,
      },
      likeKind: "reactions", // FB "likes" are all reaction types
      reachIsDistinct: false,
      source: "api",
      ...(() => {
        const d = worstDegradation(insightsDegradation, fieldsDegradation);
        return d ? { degraded: d } : {};
      })(),
    };
  }

  /**
   * Analytics for a bare Video node id (video posts). Only Video-node-valid
   * metrics/fields are requested — `shares`/`reactions` are NOT Video-node
   * fields and would fail the whole Graph call (error #100). Video views map
   * onto `impressions`, matching the documented "views ride on impressions"
   * convention (YouTube/Threads) that Reports relies on.
   */
  private async getVideoAnalytics(tokens: OAuthTokens, videoId: string): Promise<SocialAnalytics | null> {
    const insightsRes = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${videoId}/video_insights?metric=total_video_impressions,total_video_views&access_token=${tokens.accessToken}`
    );

    const insightsData: any = await insightsRes.json();
    let degraded: AnalyticsDegradation | undefined;
    if (!insightsRes.ok) {
      console.warn(`[Facebook] video_insights failed for ${videoId}: ${JSON.stringify(insightsData)}`);
      // VERIFIED 2026-08-06: without read_insights this path fails LOUDLY with
      // #200 "read_insights permission missing" (unlike the feed edge, which
      // returns a silent empty). Capture it so the UI can prompt a reconnect.
      degraded = diagnoseMetaError(insightsData?.error);
    }

    const metrics: Record<string, number> = {};
    const insightRows: any[] = Array.isArray(insightsData?.data) ? insightsData.data : [];
    for (const metric of insightRows) {
      metrics[metric.name] = metric.values?.[0]?.value || 0;
    }
    // Views are only real when the insights call actually produced rows.
    const viewsUsable = insightsRes.ok && insightRows.length > 0;

    const videoRes = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${videoId}?fields=likes.summary(true),comments.summary(true)&access_token=${tokens.accessToken}`
    );

    const videoData: any = await videoRes.json();
    // ⚠️ Do NOT return null here. A fields failure (e.g. missing
    // pages_read_user_content) used to discard successfully-fetched
    // video_insights, throwing away real view counts. Degrade per-metric instead.
    let likes: number | null = null;
    let comments: number | null = null;
    if (videoRes.ok) {
      likes = videoData.likes?.summary?.total_count ?? null;
      comments = videoData.comments?.summary?.total_count ?? null;
    } else {
      console.warn(`[Facebook] video fields fetch failed for ${videoId}: ${JSON.stringify(videoData)}`);
      degraded = worstDegradation(degraded, diagnoseMetaError(videoData?.error));
      // Nothing usable at all — no views AND no engagement. Returning null lets
      // the sync worker treat it as "no analytics" rather than storing zeros.
      if (!viewsUsable) return null;
    }

    const impressions = viewsUsable
      ? metrics.total_video_impressions || metrics.total_video_views || 0
      : 0;

    // Scraper fallback: only when the API could NOT report views (permission
    // error / zero rows) — NOT when it legitimately reported 0 views. Scraping a
    // genuinely-zero-view video wastes a request and can overwrite a true 0 with
    // a stale public number. Fail-open: on any miss we keep the API result.
    // ⚠️ Scraper-backed — verify from the deploy IP.
    if (!viewsUsable) {
      const scraped = await scrapeFacebookReelEngagement(videoId, {
        timeoutMs: Number(process.env.FB_SCRAPE_TIMEOUT_MS ?? 6000),
      }).catch(() => null);
      if (scraped && scraped.views != null && scraped.views > 0) {
        // Prefer the SCRAPED value, falling back to the API's. We only reach this
        // branch because video_insights could not report views, and on a Reel the
        // Video-node fields are unreliable in the same way — whereas the scraper
        // reads the counts rendered on the page itself. NULL stays NULL: a metric
        // neither source produced must never be stored as a confident 0.
        const mergedLikes = scraped.likes ?? likes ?? null;
        const mergedComments = scraped.comments ?? comments ?? null;
        return {
          impressions: scraped.views,
          clicks: 0,
          likes: mergedLikes ?? 0,
          shares: 0,
          comments: mergedComments ?? 0,
          reach: 0,
          // Left at 0 deliberately: every read path recomputes the rate from
          // impressioned rows. Computing it here would mix units with the SQL
          // recompute (stored rate is a fraction on some platforms, a percent on
          // others) — the bug the pooled recompute exists to avoid.
          engagementRate: 0,
          source: "scrape",
          // parseFbReelHtml reads the og:title REACTIONS segment, not "likes" —
          // same semantics as the feed path, which also declares "reactions".
          likeKind: "reactions",
          reachIsDistinct: false,
          // ⚠️ ALL SIX keys are declared. An OMITTED key reads as AVAILABLE in
          // gatePostReportRow/effectiveChannelUnavailable, so the previous 3-key
          // object published `shares: 0` and `likes: 0` as confident measurements.
          // `shares` is the worst of these: scrapeFacebookReelEngagement returns
          // `shares: null` UNCONDITIONALLY, so the old `scraped.shares ?? 0` was a
          // fabricated zero on every scraped capture.
          metricsAvailable: {
            impressions: true, // a real view count was read off the page
            reach: false, // deleted by Meta platform-wide; no source, ever
            clicks: false, // the Video node exposes no clicks edge
            likes: mergedLikes !== null, // og:title often has no reactions segment
            comments: mergedComments !== null,
            shares: false, // the scraper structurally cannot read shares
          },
          ...(degraded ? { degraded } : {}),
        };
      }
    }

    const engagementRate =
      impressions > 0 ? ((likes ?? 0) + (comments ?? 0)) / impressions : 0;

    return {
      impressions,
      clicks: 0,
      likes: likes ?? 0,
      shares: 0,
      comments: comments ?? 0,
      reach: 0,
      engagementRate,
      likeKind: "likes",
      reachIsDistinct: false,
      source: "api",
      // Video-node insights don't expose reach/shares/clicks — mark unavailable
      // so the UI renders "—", not a fake 0. `impressions` is declared TRUE when
      // video_insights delivered rows: this is the per-capture override that
      // keeps real FB video views from being hidden by the platform-wide static
      // map (which marks FACEBOOK impressions unavailable for FEED posts).
      metricsAvailable: {
        reach: false,
        shares: false,
        clicks: false,
        impressions: viewsUsable,
        likes: likes !== null,
        comments: comments !== null,
      },
      ...(degraded ? { degraded } : {}),
    };
  }

  // ── Token management ─────────────────────────────────────────────────

  private async exchangeForLongLivedToken(
    accessToken: string,
    clientId: string,
    clientSecret: string
  ): Promise<OAuthTokens> {
    const params = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: clientId,
      client_secret: clientSecret,
      fb_exchange_token: accessToken,
    });

    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/oauth/access_token?${params.toString()}`,
      {},
      undefined,
      CONNECT_GRAPH_OPTS
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Facebook long-lived token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.access_token,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : undefined,
      scopes: data.token_type ? [data.token_type] : undefined,
    };
  }

  // ── Media helpers ────────────────────────────────────────────────────

  private async fetchMediaAsBuffer(mediaUrl: string): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
    const res = await fetch(mediaUrl);
    if (!res.ok) throw new Error(`Failed to fetch media from ${mediaUrl}: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    let contentType = res.headers.get("content-type") || "";

    if (!contentType || contentType.startsWith("application/octet-stream") || contentType.startsWith("binary/")) {
      const urlPath = mediaUrl.split("?")[0] ?? "";
      const urlExt = urlPath.split(".").pop()?.toLowerCase() ?? "";
      const mimeMap: Record<string, string> = {
        mp4: "video/mp4",
        mov: "video/quicktime",
        webm: "video/webm",
        avi: "video/avi",
        mkv: "video/x-matroska",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
      };
      contentType = mimeMap[urlExt] || "image/jpeg";
    }

    const ext = contentType.split("/")[1]?.split(";")[0] ?? "jpg";
    const fileExt = ext === "jpeg" ? "jpg" : ext === "quicktime" ? "mov" : ext;
    return { buffer, contentType, fileName: `upload.${fileExt}` };
  }

  private buildMultipartBody(
    fields: Record<string, string>,
    file: { name: string; contentType: string; buffer: Buffer }
  ): { body: Uint8Array; contentType: string } {
    const boundary = `----FacebookUpload${Date.now()}`;
    const parts: Buffer[] = [];

    for (const [key, value] of Object.entries(fields)) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      ));
    }

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="${file.name}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
    ));
    parts.push(file.buffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    return {
      body: Buffer.concat(parts),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  // ── Photo/video uploads ──────────────────────────────────────────────

  private async uploadPhotoToFacebook(
    tokens: OAuthTokens,
    pageId: string,
    mediaUrl: string,
    published: boolean,
    message?: string
  ): Promise<{ id: string; post_id?: string }> {
    const { buffer, contentType, fileName } = await this.fetchMediaAsBuffer(mediaUrl);

    const fields: Record<string, string> = {
      access_token: tokens.accessToken,
      published: String(published),
    };
    if (message) fields["message"] = message;

    const { body, contentType: multipartContentType } = this.buildMultipartBody(fields, { name: fileName, contentType, buffer });

    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${pageId}/photos`,
      {
        method: "POST",
        headers: { "Content-Type": multipartContentType },
        body: new Uint8Array(body),
      },
      pageId
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Facebook photo post failed: ${JSON.stringify(data)}`);
    return data;
  }

  private async uploadVideoToFacebook(
    tokens: OAuthTokens,
    pageId: string,
    mediaUrl: string,
    message?: string
  ): Promise<{ id: string; post_id?: string }> {
    // Probe the size WITHOUT downloading. Large files are published via
    // `file_url` remote-pull so the worker never buffers a multi-GB video
    // (the buffered path holds ~3× the file size in RAM and hits Node's
    // 4GiB Buffer ceiling). Unknown size (probe failed) or small files keep
    // the classic buffered multipart path byte-identical.
    let remoteSize: number | null = null;
    try {
      remoteSize = (await headRemoteMedia(mediaUrl)).size;
    } catch {
      // Size unknown — fall through to the buffered path.
    }

    if (remoteSize != null && remoteSize > FB_URL_PULL_MIN_BYTES) {
      const params = new URLSearchParams({
        access_token: tokens.accessToken,
        file_url: mediaUrl,
      });
      if (message) params.set("description", message);

      const pullRes = await this.graphFetch(
        `${this.graphBaseUrl}/${this.apiVersion}/${pageId}/videos`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        },
        pageId
      );

      const pullData: any = await pullRes.json();
      if (!pullRes.ok) throw new Error(`Facebook video post failed: ${JSON.stringify(pullData)}`);
      return pullData;
    }

    const { buffer, contentType, fileName } = await this.fetchMediaAsBuffer(mediaUrl);

    const fields: Record<string, string> = {
      access_token: tokens.accessToken,
    };
    if (message) fields["description"] = message;

    const { body, contentType: multipartContentType } = this.buildMultipartBody(
      fields,
      { name: fileName, contentType, buffer }
    );

    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${pageId}/videos`,
      {
        method: "POST",
        headers: { "Content-Type": multipartContentType },
        body: new Uint8Array(body),
      },
      pageId
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Facebook video post failed: ${JSON.stringify(data)}`);
    return data;
  }

  // ── Publish with media ───────────────────────────────────────────────

  private async publishPostWithMedia(
    tokens: OAuthTokens,
    payload: SocialPostPayload,
    pageId: string
  ): Promise<SocialPostResult> {
    const mediaUrls = payload.mediaUrls!;

    const firstUrl = mediaUrls[0]!;
    const isVideo = /\.(mp4|mov|avi|mkv|webm)$/i.test(firstUrl) ||
      (payload.mediaTypes?.[0] ?? "").startsWith("video/");

    if (isVideo) {
      const data = await this.uploadVideoToFacebook(tokens, pageId, firstUrl, payload.content);
      const postId = data.post_id || data.id;
      // The {page}/videos edge returns only a bare Video node id (no post_id),
      // so the "{page}_{post}" → /posts/ permalink rewrite is a no-op for
      // videos — facebook.com/{videoId} is a dead link. Use the canonical
      // /{page}/videos/{id} form instead; if Graph ever DOES return post_id,
      // the existing permalink form still wins.
      const url = data.post_id
        ? `https://www.facebook.com/${data.post_id.replace("_", "/posts/")}`
        : `https://www.facebook.com/${pageId}/videos/${data.id}`;
      return {
        platformPostId: postId,
        url,
        metadata: data,
      };
    }

    if (mediaUrls.length === 1) {
      const data = await this.uploadPhotoToFacebook(tokens, pageId, firstUrl, true, payload.content);
      const postId = data.post_id || data.id;
      return {
        platformPostId: postId,
        url: `https://www.facebook.com/${postId.replace("_", "/posts/")}`,
        metadata: data,
      };
    }

    // Multi-photo: upload sequentially with spacing to stay under rate limits
    // (parallel uploads burn through the call budget fast)
    const photoIds: string[] = [];
    for (const url of mediaUrls) {
      const data = await this.uploadPhotoToFacebook(tokens, pageId, url, false);
      photoIds.push(data.id);
    }

    const attachedMedia = photoIds.map((id) => ({ media_fbid: id }));
    const feedRes = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${pageId}/feed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: payload.content,
          access_token: tokens.accessToken,
          attached_media: attachedMedia,
        }),
      },
      pageId
    );

    const feedData: any = await feedRes.json();
    if (!feedRes.ok) throw new Error(`Facebook multi-photo post failed: ${JSON.stringify(feedData)}`);

    return {
      platformPostId: feedData.id,
      url: `https://www.facebook.com/${feedData.id.replace("_", "/posts/")}`,
      metadata: feedData,
    };
  }
}
