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

    const res = await fetch(
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
      containerParams["media_type"] = "REELS"; // Instagram supports REELS for video
    } else {
      containerParams["image_url"] = mediaUrl;
    }

    const containerId = await this.createMediaContainer(tokens, igUserId, containerParams);

    // For videos, wait for processing before publishing
    if (isVideo) {
      await this.waitForMediaReady(tokens, containerId);
    }

    // Step 2: Publish the container
    return this.publishContainer(tokens, igUserId, containerId);
  }

  /**
   * Poll until the media container status is FINISHED (ready to publish).
   * Instagram video processing can take 30-90 seconds.
   */
  private async waitForMediaReady(tokens: OAuthTokens, containerId: string, maxWaitMs = 90000): Promise<void> {
    const pollInterval = 5000;
    const maxAttempts = Math.ceil(maxWaitMs / pollInterval);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, pollInterval));

      const res = await fetch(
        `${this.graphBaseUrl}/${this.apiVersion}/${containerId}?fields=status_code,status&access_token=${tokens.accessToken}`
      );
      const data: any = await res.json();

      if (data.status_code === "FINISHED") return;
      if (data.status_code === "ERROR" || data.status_code === "EXPIRED") {
        throw new Error(`Instagram media processing failed: ${data.status || data.status_code}`);
      }
    }

    throw new Error("Instagram video processing timed out after 90 seconds");
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

    const res = await fetch(
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

    while (url) {
      const pagesRes = await fetch(url);
      const pagesData: any = await pagesRes.json();
      if (!pagesRes.ok) break;

      for (const page of pagesData.data || []) {
        if (page.instagram_business_account?.id) {
          // Fetch IG profile details
          try {
            const igRes = await fetch(
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
    const res = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}/insights?metric=impressions,reach,engagement&access_token=${tokens.accessToken}`
    );

    const data: any = await res.json();
    if (!res.ok) {
      console.warn(`[Instagram] insights failed for ${platformPostId}: ${JSON.stringify(data)}`);
      // Fall through — try fetching basic like/comment counts directly
    }

    const metrics: Record<string, number> = {};
    if (data.data) {
      for (const metric of data.data) {
        metrics[metric.name] = metric.values?.[0]?.value || metric.value || 0;
      }
    }

    // Also fetch basic engagement fields from the media object itself
    const mediaRes = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}?fields=like_count,comments_count&access_token=${tokens.accessToken}`
    );

    const mediaData: any = await mediaRes.json();
    if (!mediaRes.ok) {
      console.warn(`[Instagram] media fields failed for ${platformPostId}: ${JSON.stringify(mediaData)}`);
      return null;
    }
    const likes = mediaData.like_count || 0;
    const comments = mediaData.comments_count || 0;

    const impressions = metrics.impressions || 0;
    const totalEngagement = metrics.engagement || likes + comments;
    const engagementRate = impressions > 0 ? totalEngagement / impressions : 0;

    return {
      impressions,
      clicks: 0, // Instagram does not expose click counts via the API
      likes,
      shares: 0, // Instagram does not expose share counts via the API
      comments,
      reach: metrics.reach || 0,
      engagementRate,
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

    const res = await fetch(
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

    while (url) {
      const pagesRes = await fetch(url);
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
    const res = await fetch(
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

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Instagram publish failed: ${JSON.stringify(data)}`);

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

    // Step 1: Create individual item containers (children of the carousel)
    const childContainerIds = await Promise.all(
      mediaUrls.map(async (url) => {
        const res = await fetch(
          `${this.graphBaseUrl}/${this.apiVersion}/${igUserId}/media`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              image_url: url,
              is_carousel_item: true,
              access_token: tokens.accessToken,
            }),
          }
        );

        const data: any = await res.json();
        if (!res.ok) throw new Error(`Instagram carousel item upload failed: ${JSON.stringify(data)}`);
        return data.id;
      })
    );

    // Step 2: Create the carousel container
    const carouselRes = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${igUserId}/media`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          media_type: "CAROUSEL",
          caption: payload.content,
          children: childContainerIds.join(","),
          access_token: tokens.accessToken,
        }),
      }
    );

    const carouselData: any = await carouselRes.json();
    if (!carouselRes.ok) throw new Error(`Instagram carousel container creation failed: ${JSON.stringify(carouselData)}`);

    // Step 3: Publish the carousel
    return this.publishContainer(tokens, igUserId, carouselData.id);
  }
}
