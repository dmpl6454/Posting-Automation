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

/** Max pagination pages fetched during connect (~500 Pages at limit=25). */
const MAX_CONNECT_PAGINATION_PAGES = 20;

/**
 * How long to wait for a VIDEO container to reach FINISHED.
 *
 * Was a flat 90s, which is duration-blind: Instagram's own transcode scales with
 * reel length, so a 102s reel needs far longer than a 10s one. On 2026-08-07 a
 * single 102s reel fanned out to 39 channels lost 22 of them to
 * "media processing timed out after 90 seconds" — the containers were still
 * IN_PROGRESS, not broken. Raised to 4 min so a long reel under load finishes
 * instead of being marked FAILED. Bounded (not unbounded) because the poll holds
 * a publish-worker slot; still far inside the watchdog's 30-min idle reap.
 */
const VIDEO_READY_TIMEOUT_MS = Math.max(
  30_000,
  parseInt(process.env.IG_VIDEO_READY_TIMEOUT_MS || "", 10) || 240_000
);

export class InstagramProvider extends SocialProvider {
  readonly platform: SocialPlatform = "INSTAGRAM";
  readonly displayName = "Instagram";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 2200,
    supportedMediaTypes: ["image/jpeg", "image/png"],
    maxMediaCount: 10,
    maxMediaSize: 8 * 1024 * 1024,
  };

  private readonly apiVersion = "v18.0";
  private readonly graphBaseUrl = "https://graph.facebook.com";

  getOAuthUrl(config: OAuthConfig, state: string): string {
    // Instagram Graph API uses Facebook OAuth flow
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      scope: config.scopes.join(","),
      state,
      response_type: "code",
    });
    return `https://www.facebook.com/${this.apiVersion}/dialog/oauth?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    // Exchange authorization code for a short-lived token via Facebook OAuth
    const params = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.callbackUrl,
      code,
    });

    const res = await fetchT(
      `${this.graphBaseUrl}/${this.apiVersion}/oauth/access_token?${params.toString()}`
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Instagram token exchange failed: ${JSON.stringify(data)}`);

    // Exchange short-lived token for a long-lived token
    const longLivedTokens = await this.exchangeForLongLivedToken(
      data.access_token,
      config.clientId,
      config.clientSecret
    );

    return longLivedTokens;
  }

  async refreshAccessToken(_refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    // Instagram (via Facebook) does not use traditional refresh tokens.
    // Exchange the existing long-lived token for a new long-lived token.
    const longLivedTokens = await this.exchangeForLongLivedToken(
      _refreshToken,
      config.clientId,
      config.clientSecret
    );

    return longLivedTokens;
  }

  validateContent(payload: SocialPostPayload): string[] {
    const errors = super.validateContent(payload);
    if (!payload.mediaUrls || payload.mediaUrls.length === 0) {
      errors.push("Instagram requires at least one image or video to publish a post.");
    } else if (!payload.mediaUrls[0]?.startsWith("http")) {
      errors.push("Instagram requires a valid publicly accessible media URL (must start with http/https).");
    }
    return errors;
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const igUserId = (payload.metadata?.igUserId as string) || (await this.getInstagramBusinessAccountId(tokens));

    if (payload.mediaUrls && payload.mediaUrls.length > 1) {
      return this.publishCarouselPost(tokens, payload, igUserId);
    }

    // Single image or single video post
    const mediaUrl = payload.mediaUrls?.[0];
    if (!mediaUrl || !mediaUrl.startsWith("http")) {
      throw new Error("Instagram requires a valid publicly accessible media URL to publish a post.");
    }

    // Detect if this is a video
    const isVideo = /\.(mp4|mov|avi|mkv|webm)$/i.test(mediaUrl) ||
      (payload.mediaTypes?.[0] ?? "").startsWith("video/");

    // Step 1: Create a media container (image_url for images, video_url for videos)
    const containerParams: Record<string, string> = {
      caption: payload.content,
    };

    if (isVideo) {
      containerParams["video_url"] = mediaUrl;
      const fmt = String(payload.metadata?.format ?? "REEL").toUpperCase();
      containerParams["media_type"] = fmt === "STORY" ? "STORIES" : "REELS";
    } else {
      containerParams["image_url"] = mediaUrl;
    }

    const containerId = await this.createMediaContainer(tokens, igUserId, containerParams);

    // Wait for the container to reach FINISHED before publishing. Instagram
    // processes ALL media asynchronously — not just videos. Publishing an image
    // container too soon returns OAuthException code 9007 / subcode 2207027
    // ("Media ID is not available / The media is not ready to be published").
    // Videos can take 30-90s; images are usually a few seconds but are NOT
    // instant, especially larger files. Poll faster (2s) and shorter (30s) for
    // images so the common case stays snappy; keep the long 90s budget for video.
    await this.waitForMediaReady(
      tokens,
      containerId,
      isVideo ? VIDEO_READY_TIMEOUT_MS : 30000,
      isVideo ? 5000 : 2000,
    );

    // Step 2: Publish the container
    return this.publishContainer(tokens, igUserId, containerId);
  }

  /**
   * Poll until the media container status is FINISHED (ready to publish).
   * Applies to images AND videos — Instagram processes all media asynchronously.
   * Video processing can take 30-90s; images are usually a few seconds.
   * Treats a still-IN_PROGRESS / missing status_code as "keep waiting" (the
   * status field can lag right after container creation), only failing on an
   * explicit ERROR/EXPIRED or after the timeout budget is exhausted.
   */
  private async waitForMediaReady(
    tokens: OAuthTokens,
    containerId: string,
    maxWaitMs = 90000,
    pollInterval = 5000,
  ): Promise<void> {
    const maxAttempts = Math.ceil(maxWaitMs / pollInterval);
    const startedAt = Date.now();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, pollInterval));

      const res = await fetch(
        `${this.graphBaseUrl}/${this.apiVersion}/${containerId}?fields=status_code,status&access_token=${tokens.accessToken}`
      );
      const data: any = await res.json();

      // FINISHED = ready to publish; PUBLISHED = already published (defensive).
      if (data.status_code === "FINISHED" || data.status_code === "PUBLISHED") return;
      if (data.status_code === "ERROR" || data.status_code === "EXPIRED") {
        throw new Error(`Instagram media processing failed: ${data.status || data.status_code}`);
      }
      // IN_PROGRESS, an unknown status, or a transient read error → keep polling.
    }

    // Report ACTUAL elapsed, not the budget: each iteration sleeps `pollInterval`
    // and then awaits a network read, so a busy worker overshoots the nominal
    // budget. Printing the budget made the 2026-08-07 incident look like a hard
    // 90s cutoff when the real waits were longer — hiding how close these
    // containers were to finishing.
    const waitedSec = Math.round((Date.now() - startedAt) / 1000);
    throw new Error(
      `Instagram media processing did not finish within ${waitedSec}s ` +
        `(budget ${Math.round(maxWaitMs / 1000)}s) — the video is still processing on Instagram's side, not rejected`
    );
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    // Instagram Graph API does not natively support deleting posts via the API.
    // Attempt the deletion; this may fail depending on permissions.
    const res = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}?access_token=${tokens.accessToken}`,
      { method: "DELETE" }
    );

    if (!res.ok) {
      const data: any = await res.json();
      throw new Error(`Instagram delete failed: ${JSON.stringify(data)}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    // First get the Instagram Business Account ID via Facebook Pages
    const igUserId = await this.getInstagramBusinessAccountId(tokens);

    const res = await fetchT(
      `${this.graphBaseUrl}/${this.apiVersion}/${igUserId}?fields=id,username,profile_picture_url&access_token=${tokens.accessToken}`
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Instagram profile fetch failed: ${JSON.stringify(data)}`);

    return {
      id: data.id,
      name: data.username || data.id,
      username: data.username,
      avatar: data.profile_picture_url,
    };
  }

  /**
   * Fetch ALL Instagram Business Accounts linked to the user's Facebook Pages.
   * Returns an array of IG accounts with their profile info.
   */
  async getAllInstagramAccounts(tokens: OAuthTokens): Promise<Array<{
    id: string;
    name: string;
    username?: string;
    avatar?: string;
  }>> {
    const accounts: Array<{ id: string; name: string; username?: string; avatar?: string }> = [];
    let url: string | null = `${this.graphBaseUrl}/${this.apiVersion}/me/accounts?fields=id,instagram_business_account&limit=25&access_token=${tokens.accessToken}`;
    let pageCount = 0;

    while (url) {
      if (pageCount >= MAX_CONNECT_PAGINATION_PAGES) {
        console.warn(`[Instagram] getAllInstagramAccounts: pagination capped at ${MAX_CONNECT_PAGINATION_PAGES} pages (${accounts.length} accounts loaded) — truncating`);
        break;
      }
      pageCount++;

      const pagesRes = await fetchT(url);
      const pagesData: any = await pagesRes.json();
      if (!pagesRes.ok) {
        // Keep the break (return whatever was collected so far — same contract),
        // but don't be silent about the partial result.
        console.warn(`[Instagram] getAllInstagramAccounts: pagination response not ok (HTTP ${pagesRes.status}) — returning partial result (${accounts.length} accounts): ${JSON.stringify(pagesData?.error ?? pagesData)}`);
        break;
      }

      for (const page of pagesData.data || []) {
        if (page.instagram_business_account?.id) {
          // Fetch IG profile details
          try {
            const igRes = await fetchT(
              `${this.graphBaseUrl}/${this.apiVersion}/${page.instagram_business_account.id}?fields=id,username,profile_picture_url&access_token=${tokens.accessToken}`
            );
            const igData: any = await igRes.json();
            if (igRes.ok) {
              accounts.push({
                id: igData.id,
                name: igData.username || igData.id,
                username: igData.username,
                avatar: igData.profile_picture_url,
              });
            }
          } catch {
            // Skip this account if profile fetch fails
          }
        }
      }

      url = pagesData.paging?.next || null;
    }

    return accounts;
  }

  /**
   * List the IG account's own media — including posts made directly in the app.
   *
   *   GET /{ig-user-id}/media
   *       ?fields=id,timestamp,caption,media_product_type,media_type,permalink
   *       &since=<unix>&limit=25
   *
   * ⚠️ IG media ids are BARE (e.g. 17912345678901234) and are the SAME ids that
   * publishing returns, so dedup against PostTarget.publishedId is an exact string
   * match — no resolution step, unlike Facebook's bare Video-node ids. Measured: all 60
   * app-published IG targets since 2026-08-01 carry bare ids.
   *
   * ⚠️ `media_product_type` is captured here because IG insight metric sets are
   * PER PRODUCT TYPE and MUTUALLY EXCLUSIVE (FEED / REELS / STORY). Mixing them 400s
   * the entire call and zeroes every metric — the all-or-nothing regression PR #148
   * already fixed once. Persisting it lets the metric pass pick the right set without
   * a second media read.
   *
   * ⚠️ REALITY CHECK (measured 2026-08-06): 0 of 12 sampled IG tokens were alive — every
   * one returned 190/460 "session invalidated". This method is correct and will start
   * returning data the moment owners reconnect; until then it degrades honestly rather
   * than reporting "no posts".
   */
  async listRecentPosts(
    tokens: OAuthTokens,
    igUserId: string,
    opts: ListPostsOptions
  ): Promise<ExternalPostPage> {
    const since = Math.floor(opts.since.getTime() / 1000);
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    const cursor = opts.cursor ? `&after=${encodeURIComponent(opts.cursor)}` : "";

    const res = await fetchT(
      `${this.graphBaseUrl}/${this.apiVersion}/${igUserId}/media` +
        `?fields=id,timestamp,caption,media_product_type,media_type,permalink` +
        `&since=${since}&limit=${limit}${cursor}&access_token=${tokens.accessToken}`
    );
    const data: any = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.warn(`[Instagram] listRecentPosts failed for ${igUserId}: ${JSON.stringify(data?.error ?? data).slice(0, 300)}`);
      return { posts: [], degraded: diagnoseMetaError(data?.error) };
    }

    const posts: ExternalPostSummary[] = [];
    for (const row of Array.isArray(data?.data) ? data.data : []) {
      if (!row?.id || !row?.timestamp) continue;
      const when = new Date(row.timestamp);
      if (Number.isNaN(when.getTime())) continue;
      // Defensive: `since` has been unreliable on some IG API versions, so enforce the
      // floor locally too. A post older than the window must never enter the store.
      if (when.getTime() < opts.since.getTime()) continue;
      posts.push({
        platformPostId: String(row.id),
        publishedAt: when,
        ...(row.permalink ? { permalink: String(row.permalink) } : {}),
        ...(row.caption ? { message: String(row.caption).slice(0, 2000) } : {}),
        ...(row.media_type ? { mediaType: String(row.media_type) } : {}),
        ...(row.media_product_type ? { productType: String(row.media_product_type) } : {}),
      });
    }

    return {
      posts,
      ...(data?.paging?.cursors?.after && data?.paging?.next
        ? { nextCursor: String(data.paging.cursors.after) }
        : {}),
    };
  }

  async getPostAnalytics(tokens: OAuthTokens, platformPostId: string): Promise<SocialAnalytics | null> {
    // Fetch the media object FIRST — media_product_type decides which insights
    // metric set is valid. Every IG video publishes as REELS (or STORIES), and
    // Meta's insights endpoint is all-or-nothing: requesting a FEED metric
    // (impressions/engagement) on a Reel fails the WHOLE call with error #100,
    // zeroing even valid metrics like reach.
    const mediaRes = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}?fields=like_count,comments_count,media_product_type&access_token=${tokens.accessToken}`
    );

    const mediaData: any = await mediaRes.json();
    if (!mediaRes.ok) {
      console.warn(`[Instagram] media fields failed for ${platformPostId}: ${JSON.stringify(mediaData)}`);
      // A dead or under-scoped token fails HERE, before insights are ever
      // attempted — the single most common failure mode in production. Returning
      // a bare null loses the diagnosis, so the channel keeps rendering zeros
      // with no hint that it needs reconnecting. Instead, return a fully
      // UNAVAILABLE row carrying the reason: every metric renders "—" exactly as
      // it did before (so the visible table is unchanged), but the reconnect
      // signal now reaches the UI. Non-actionable errors keep the old null.
      const mediaDegradation = diagnoseMetaError(mediaData?.error);
      if (!mediaDegradation) return null;
      return {
        impressions: 0,
        clicks: 0,
        likes: 0,
        shares: 0,
        comments: 0,
        reach: 0,
        engagementRate: 0,
        likeKind: "likes",
        reachIsDistinct: true,
        source: "api",
        metricsAvailable: {
          impressions: false,
          reach: false,
          likes: false,
          comments: false,
          shares: false,
          clicks: false,
        },
        degraded: mediaDegradation,
      };
    }
    const likes = mediaData.like_count || 0;
    const comments = mediaData.comments_count || 0;
    const productType = String(mediaData.media_product_type ?? "").toUpperCase();

    // Metric sets per media_product_type — LIVE-VERIFIED by probing every metric
    // name INDIVIDUALLY on real REELS / FEED media (2026-07-24, re-verified and
    // EXTENDED 2026-08-06 with `instagram_manage_insights` granted).
    //
    // Meta's /insights?metric= is ALL-OR-NOTHING: one unsupported name fails the
    // WHOLE call with #100 and zeroes every metric in the set. Verified-valid:
    //   FEED  (incl. carousels — a carousel is media_product_type FEED with
    //          media_type CAROUSEL_ALBUM):
    //     reach,saved,shares,views,likes,comments,total_interactions,
    //     profile_visits,profile_activity,follows
    //   REELS:
    //     reach,saved,shares,views,likes,comments,total_interactions,
    //     ig_reels_avg_watch_time,ig_reels_video_view_total_time
    //   STORY (no saved/likes/comments; adds replies/navigation):
    //     reach,shares,views,total_interactions,replies,navigation
    //
    // ⚠️ The sets are MUTUALLY EXCLUSIVE — never union them. `profile_visits`,
    // `profile_activity` and `follows` are NOT supported for REELS: adding them
    // to a shared set makes the combined REELS call fail outright (verified:
    // "#100 does not support the profile_visits, profile_activity, follows metric
    // for this media product type"), zeroing every metric for that Reel. That is
    // the same all-or-nothing regression PR #148 already fixed once.
    //
    // Do NOT re-add `impressions` ("no longer supported" from v22.0), `plays`,
    // `engagement`, `clips_replays_count`, `ig_reels_aggregated_all_plays_count`
    // or `video_views` — all verified invalid.
    // `views` carries the impressions slot; `total_interactions` the engagement
    // slot. Verified real sample (a Reel): reach=106, views=115, saved=1,
    // total_interactions=1, ig_reels_avg_watch_time=3038ms.
    const BASE_SET = "reach,saved,shares,views,likes,comments,total_interactions";
    const preferredSet =
      productType === "STORY"
        ? "reach,shares,views,total_interactions,replies,navigation"
        : productType === "REELS"
          ? `${BASE_SET},ig_reels_avg_watch_time,ig_reels_video_view_total_time`
          : productType === "FEED"
            ? `${BASE_SET},profile_visits,profile_activity,follows`
            : BASE_SET;

    const metrics: Record<string, number> = {};
    /** Metric names Meta actually RETURNED — the basis for honest availability. */
    const present = new Set<string>();
    let degraded: AnalyticsDegradation | undefined;

    const readInsights = async (metricParam: string): Promise<boolean> => {
      const res = await fetch(
        `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}/insights?metric=${metricParam}&access_token=${tokens.accessToken}`
      );
      const data: any = await res.json();
      if (!res.ok) {
        console.warn(`[Instagram] insights (${metricParam}) failed for ${platformPostId}: ${JSON.stringify(data)}`);
        // Only permission/token problems are actionable; an unsupported-metric
        // #100 is a set-shape problem the ladder below handles itself.
        degraded = worstDegradation(degraded, diagnoseMetaError(data?.error));
        return false;
      }
      const rows: any[] = Array.isArray(data?.data) ? data.data : [];
      for (const metric of rows) {
        metrics[metric.name] = metric.values?.[0]?.value || metric.value || 0;
        present.add(metric.name);
      }
      // A 200 carrying zero rows is the silent-empty signature of a missing
      // scope (same class as the FB feed edge) — `reach` is always returned when
      // permitted, for every media product type.
      if (rows.length === 0) {
        degraded = worstDegradation(
          degraded,
          diagnoseEmptyInsights(0, true, "instagram_manage_insights")
        );
        return false;
      }
      return true;
    };

    // Degradation ladder: preferred (type-specific, richest) → base (the set
    // verified safe for every type) → `reach` alone. Because /insights is
    // all-or-nothing, this guarantees a newly-added type-specific metric can
    // NEVER cost us the base metrics if Meta rejects it for some media type.
    // Descends only on failure, so the happy path stays a single call.
    if (!(await readInsights(preferredSet))) {
      if (preferredSet !== BASE_SET) {
        if (!(await readInsights(BASE_SET))) await readInsights("reach");
      } else {
        await readInsights("reach");
      }
    }

    // Instagram has NO impressions metric — Meta deleted it in v22.0 ("the
    // impressions metric is no longer supported for the queried media"), and no
    // permission restores it. What this provider has always stored in the
    // `impressions` slot is Meta's `views` count, which is a genuinely different
    // quantity from `reach`: measured across 62,324 prod rows, views > reach on
    // 62,081 of them (mean ratio 3.49x for REELS, 2.07x for FEED).
    //
    // ⚠️ The value is written to BOTH slots on purpose. `views` is the honest
    // column the UI renders; `impressions` is retained so the engagement-rate
    // denominator and every historical row keep working byte-identically. The
    // capability map declares INSTAGRAM impressions unavailable, so the UI never
    // shows the same number twice under two names.
    const views = metrics.views ?? 0;
    const impressions = views;
    const totalEngagement = metrics.total_interactions ?? likes + comments;
    const engagementRate = impressions > 0 ? totalEngagement / impressions : 0;

    return {
      impressions,
      ...(present.has("views") ? { views } : {}),
      clicks: 0, // Instagram does not expose click counts via the API
      likes,
      shares: metrics.shares ?? 0,
      comments,
      reach: metrics.reach ?? 0,
      engagementRate,
      saved: present.has("saved") ? metrics.saved : undefined,
      // Reels watch time, in milliseconds (undefined for non-Reels).
      ...(present.has("ig_reels_avg_watch_time")
        ? { avgWatchTimeMs: metrics.ig_reels_avg_watch_time }
        : {}),
      ...(present.has("ig_reels_video_view_total_time")
        ? { totalWatchTimeMs: metrics.ig_reels_video_view_total_time }
        : {}),
      likeKind: "likes",
      reachIsDistinct: true, // IG reach is a genuine unique-reach metric
      source: "api",
      // Availability is derived from what Meta ACTUALLY returned, per metric.
      // The old `hasInsights` flag was a single boolean OR'd across the whole
      // call, so a partial success (product-type set fails, `reach`-only retry
      // succeeds) declared impressions and shares "available" while they had
      // never been returned — reporting a fake 0. `likes`/`comments` come from
      // the media fields object (instagram_basic), not insights, so they are
      // available whenever the media read succeeded.
      metricsAvailable: {
        clicks: false, // IG has no click metric at all
        // Both keyed on the SAME returned metric, because they hold the same
        // number. `impressions` stays declared so historical rows and the
        // engagement-rate denominator behave exactly as before; the static
        // capability map is what stops the UI rendering it as a second column.
        // ⚠️ `impressions: false` is REQUIRED, not optional — and an OMITTED key
        // is NOT equivalent. Per-capture `metricsAvailable` OVERRIDES the static
        // platform map at every consumer (gatePostReportRow, availExpr,
        // effectiveChannelUnavailable), and an omitted key reads as AVAILABLE.
        // Declaring `true` here (or omitting it) made Instagram render Impressions
        // AND Views as two columns holding the identical number — the exact
        // duplication this metric was introduced to remove. Measured on prod:
        // 66,073 IG rows, views == impressions on 100% of them, both summing
        // 2.26B, printed twice.
        impressions: false,
        views: present.has("views"),
        reach: present.has("reach"),
        shares: present.has("shares"),
      },
      ...(degraded ? { degraded } : {}),
    };
  }

  /**
   * Exchange a short-lived or existing long-lived token for a new long-lived token.
   */
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

    const res = await fetchT(
      `${this.graphBaseUrl}/${this.apiVersion}/oauth/access_token?${params.toString()}`
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Instagram long-lived token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      // Store the long-lived token as the refresh token so it can be re-exchanged before expiry.
      refreshToken: data.access_token,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : undefined,
      scopes: data.token_type ? [data.token_type] : undefined,
    };
  }

  /**
   * Retrieve the Instagram Business Account ID connected to the user's Facebook Page.
   */
  private async getInstagramBusinessAccountId(tokens: OAuthTokens): Promise<string> {
    // Get the list of Facebook Pages the user manages, with pagination
    let url: string | null = `${this.graphBaseUrl}/${this.apiVersion}/me/accounts?fields=id,instagram_business_account&limit=25&access_token=${tokens.accessToken}`;
    let pageCount = 0;

    while (url) {
      if (pageCount >= MAX_CONNECT_PAGINATION_PAGES) {
        console.warn(`[Instagram] getInstagramBusinessAccountId: pagination capped at ${MAX_CONNECT_PAGINATION_PAGES} pages without finding an IG Business Account — truncating`);
        break;
      }
      pageCount++;

      const pagesRes = await fetchT(url);
      const pagesData: any = await pagesRes.json();

      if (!pagesRes.ok) {
        console.error("Instagram: Failed to fetch Facebook pages:", JSON.stringify(pagesData));
        throw new Error(`Failed to fetch Facebook pages: ${JSON.stringify(pagesData)}`);
      }

      // Find the first page with an Instagram Business Account linked
      for (const page of pagesData.data || []) {
        if (page.instagram_business_account?.id) {
          return page.instagram_business_account.id;
        }
      }

      // Check next page
      url = pagesData.paging?.next || null;
    }

    throw new Error(
      "No Instagram Business Account found. Ensure a Facebook Page is connected to an Instagram Professional account."
    );
  }

  /**
   * Create a media container for a single image post.
   */
  private async createMediaContainer(
    tokens: OAuthTokens,
    igUserId: string,
    params: Record<string, string>
  ): Promise<string> {
    const res = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${igUserId}/media`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...params,
          access_token: tokens.accessToken,
        }),
      }
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Instagram media container creation failed: ${JSON.stringify(data)}`);

    return data.id;
  }

  /**
   * Publish a media container.
   */
  private async publishContainer(
    tokens: OAuthTokens,
    igUserId: string,
    containerId: string
  ): Promise<SocialPostResult> {
    // Even after the container reports FINISHED, media_publish can briefly still
    // return subcode 2207027 ("media is not ready to be published"). Retry a few
    // times with backoff so a one-off race resolves inside this call instead of
    // failing the whole job (which the user sees as a red "Failed" before the
    // BullMQ retry eventually fixes it). Only this specific transient subcode is
    // retried here; any other error throws immediately.
    let data: any;
    let res: Response;
    const maxPublishAttempts = 5;
    for (let attempt = 0; attempt < maxPublishAttempts; attempt++) {
      res = await fetch(
        `${this.graphBaseUrl}/${this.apiVersion}/${igUserId}/media_publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            creation_id: containerId,
            access_token: tokens.accessToken,
          }),
        }
      );

      data = await res.json();
      if (res.ok) break;

      const subcode = data?.error?.error_subcode;
      const isNotReady = subcode === 2207027 || /not ready to be published|Media ID is not available/i.test(data?.error?.error_user_msg || data?.error?.message || "");
      if (isNotReady && attempt < maxPublishAttempts - 1) {
        // Linear-ish backoff: 3s, 6s, 9s, 12s — gives the container time to settle.
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      throw new Error(`Instagram publish failed: ${JSON.stringify(data)}`);
    }

    // media_publish returns a numeric media ID, not a shortcode.
    // Fetch the permalink field to get the real post URL.
    let url = `https://www.instagram.com/p/${data.id}`;
    try {
      const permalinkRes = await fetch(
        `${this.graphBaseUrl}/${this.apiVersion}/${data.id}?fields=permalink&access_token=${tokens.accessToken}`
      );
      const permalinkData: any = await permalinkRes.json();
      if (permalinkData.permalink) url = permalinkData.permalink;
    } catch {
      // Fall back to the numeric ID URL — better than nothing
    }

    return {
      platformPostId: data.id,
      url,
      metadata: data,
    };
  }

  /**
   * Publish a carousel (multi-image) post.
   * 1. Upload each image as an individual media container (not published).
   * 2. Create a carousel container referencing all individual containers.
   * 3. Publish the carousel container.
   */
  private async publishCarouselPost(
    tokens: OAuthTokens,
    payload: SocialPostPayload,
    igUserId: string
  ): Promise<SocialPostResult> {
    const mediaUrls = payload.mediaUrls!;
    const mediaTypes = payload.mediaTypes ?? [];

    // Step 1: Create individual item containers (children of the carousel)
    // Video children require video_url + media_type=VIDEO and must wait for processing.
    const childContainerIds: string[] = [];
    for (let i = 0; i < mediaUrls.length; i++) {
      const url = mediaUrls[i]!;
      const mime = mediaTypes[i] ?? "";
      const isChildVideo = mime.startsWith("video/") || /\.(mp4|mov|avi|mkv|webm)(\?|$)/i.test(url);

      const childParams: Record<string, unknown> = { is_carousel_item: true, access_token: tokens.accessToken };
      if (isChildVideo) {
        childParams["video_url"] = url;
        childParams["media_type"] = "VIDEO";
      } else {
        childParams["image_url"] = url;
      }

      const res = await fetch(
        `${this.graphBaseUrl}/${this.apiVersion}/${igUserId}/media`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(childParams),
        }
      );

      const data: any = await res.json();
      if (!res.ok) throw new Error(`Instagram carousel item upload failed: ${JSON.stringify(data)}`);
      const childId: string = data.id;

      // Every child container must be FINISHED before the carousel container can
      // be created — images included (not just videos). Use the short image
      // budget for images, the long one for videos.
      await this.waitForMediaReady(
        tokens,
        childId,
        isChildVideo ? 90000 : 30000,
        isChildVideo ? 5000 : 2000,
      );

      childContainerIds.push(childId);
    }

    // Step 2: Create the carousel container
    const carouselRes = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${igUserId}/media`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          media_type: "CAROUSEL",
          caption: payload.content,
          children: childContainerIds,
          access_token: tokens.accessToken,
        }),
      }
    );

    const carouselData: any = await carouselRes.json();
    if (!carouselRes.ok) throw new Error(`Instagram carousel container creation failed: ${JSON.stringify(carouselData)}`);

    // The carousel container itself is processed asynchronously too — wait for
    // it to finish before publishing, or media_publish returns subcode 2207027.
    await this.waitForMediaReady(tokens, carouselData.id, 60000, 3000);

    // Step 3: Publish the carousel
    return this.publishContainer(tokens, igUserId, carouselData.id);
  }
}
