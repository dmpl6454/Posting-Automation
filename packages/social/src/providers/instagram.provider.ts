import type { SocialPlatform } from "@postautomation/db";
import { SocialProvider } from "../abstract/social.abstract";
import type {
  SocialPostPayload,
  SocialPostResult,
  SocialAnalytics,
  OAuthTokens,
  OAuthConfig,
  SocialProfile,
  PlatformConstraints,
} from "../abstract/social.types";
import { fetchT } from "../utils/fetch-timeout";

/** Max pagination pages fetched during connect (~500 Pages at limit=25). */
const MAX_CONNECT_PAGINATION_PAGES = 20;

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
      isVideo ? 90000 : 30000,
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

    throw new Error(`Instagram media processing timed out after ${Math.round(maxWaitMs / 1000)} seconds`);
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
      return null;
    }
    const likes = mediaData.like_count || 0;
    const comments = mediaData.comments_count || 0;
    const productType = String(mediaData.media_product_type ?? "").toUpperCase();

    // Metric sets per media_product_type — LIVE-VERIFIED against the v18 media
    // insights endpoint on 2026-07-24 (probing each metric name individually on
    // real REELS/FEED/STORY media). Meta's /insights?metric= is ALL-OR-NOTHING:
    // a single invalid name fails the WHOLE call with #100 and zeroes every
    // metric in the set. The old sets each carried an invalid name that silently
    // broke the whole call — `plays` (REELS) and `engagement` (FEED) both 400
    // in v18 — so only the reach-only fallback survived and views/saved/shares/
    // total_interactions were dropped for every post. Corrected, verified-valid:
    //   REELS / FEED / CAROUSEL_ALBUM / unknown:
    //     reach,saved,shares,views,likes,comments,total_interactions
    //   STORY (no saved/likes/comments; adds replies):
    //     reach,shares,views,total_interactions,replies
    // Do NOT re-add `plays`, `impressions`, or `engagement` — all invalid in v18.
    // `views` carries the impressions slot; `total_interactions` the engagement
    // slot (see the ?? chains below). Verified sample (a real Reel):
    //   reach=7046, views=11239, shares=3, saved=0, total_interactions=24.
    const metricSet =
      productType === "STORY"
        ? "reach,shares,views,total_interactions,replies"
        : "reach,saved,shares,views,likes,comments,total_interactions";

    const metrics: Record<string, number> = {};
    const readInsights = async (metricParam: string): Promise<boolean> => {
      const res = await fetch(
        `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}/insights?metric=${metricParam}&access_token=${tokens.accessToken}`
      );
      const data: any = await res.json();
      if (!res.ok) {
        console.warn(`[Instagram] insights (${metricParam}) failed for ${platformPostId}: ${JSON.stringify(data)}`);
        return false;
      }
      if (data.data) {
        for (const metric of data.data) {
          metrics[metric.name] = metric.values?.[0]?.value || metric.value || 0;
        }
      }
      return true;
    };

    // If the product-type set fails unexpectedly, retry ONCE with `reach`
    // alone (valid for every media product type) so a metric-set mismatch can
    // never zero reach again. Deliberately NOT per-metric fetches — that would
    // blow up call counts under the analytics sync limiter.
    if (!(await readInsights(metricSet))) {
      await readInsights("reach");
    }

    // `views` rides on the impressions slot for EVERY product type in v18
    // (`plays`/`impressions` are invalid names — see the metric-set note above) —
    // same "views ride on impressions" convention as YouTube/Threads. The
    // `metrics.impressions ?? metrics.plays` fallbacks are dead in v18 but kept
    // harmless in case a future API version restores those names.
    const impressions = metrics.views ?? metrics.impressions ?? metrics.plays ?? 0;
    const totalEngagement = metrics.engagement ?? metrics.total_interactions ?? likes + comments;
    const engagementRate = impressions > 0 ? totalEngagement / impressions : 0;
    const hasInsights = metrics.reach != null || impressions > 0;

    return {
      impressions,
      clicks: 0, // Instagram does not expose click counts via the API
      likes,
      shares: metrics.shares ?? 0, // Reels expose shares; other types do not
      comments,
      reach: metrics.reach ?? 0,
      engagementRate,
      saved: metrics.saved, // surfaced (Reels) — a distinct action; undefined elsewhere
      likeKind: "likes",
      reachIsDistinct: true, // IG reach is a genuine unique-reach metric
      source: "api",
      // Clicks never exist on IG; impressions/reach/shares depend on the
      // insights call (needs instagram_manage_insights). When that call fails
      // (permission-gated), impressions stays 0 and we mark them unavailable so
      // the UI renders "—" instead of a fake zero.
      metricsAvailable: {
        clicks: false,
        impressions: hasInsights,
        reach: metrics.reach != null,
        shares: hasInsights,
      },
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
