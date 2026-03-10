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

export class ThreadsProvider extends SocialProvider {
  readonly platform: SocialPlatform = "THREADS";
  readonly displayName = "Threads";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 500,
    supportedMediaTypes: ["image/jpeg", "image/png", "image/gif", "video/mp4"],
    maxMediaCount: 10,
    maxMediaSize: 8 * 1024 * 1024, // 8MB
    supportsThreads: true,
  };

  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      scope: config.scopes.join(","),
      response_type: "code",
      state,
    });
    return `https://threads.net/oauth/authorize?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    // Step 1: Get short-lived token
    const res = await fetch("https://graph.threads.net/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        redirect_uri: config.callbackUrl,
        code,
      }),
    });

    const data: any = await res.json();
    if (!res.ok || data.error) throw new Error(`Threads token exchange failed: ${JSON.stringify(data)}`);

    // Step 2: Exchange for long-lived token
    const longRes = await fetch(
      `https://graph.threads.net/access_token?` +
        new URLSearchParams({
          grant_type: "th_exchange_token",
          client_secret: config.clientSecret,
          access_token: data.access_token,
        }).toString()
    );

    const longData: any = await longRes.json();
    if (!longRes.ok || longData.error) {
      // If long-lived exchange fails, fall back to short-lived token
      return {
        accessToken: data.access_token,
        expiresAt: new Date(Date.now() + 3600 * 1000), // 1 hour
      };
    }

    return {
      accessToken: longData.access_token,
      expiresAt: new Date(Date.now() + (longData.expires_in || 5184000) * 1000), // ~60 days
    };
  }

  async refreshAccessToken(refreshToken: string, _config: OAuthConfig): Promise<OAuthTokens> {
    // Threads long-lived tokens can be refreshed
    const res = await fetch(
      `https://graph.threads.net/refresh_access_token?` +
        new URLSearchParams({
          grant_type: "th_refresh_token",
          access_token: refreshToken,
        }).toString()
    );

    const data: any = await res.json();
    if (!res.ok || data.error) throw new Error(`Threads token refresh failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + (data.expires_in || 5184000) * 1000),
    };
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const userId = (payload.metadata?.userId as string) || "me";

    // Step 1: Create media container
    const containerParams: Record<string, string> = {
      text: payload.content,
      access_token: tokens.accessToken,
    };

    if (payload.mediaUrls?.length === 1) {
      // Single media post
      const mediaUrl = payload.mediaUrls[0]!;
      const isVideo = mediaUrl.match(/\.(mp4|mov|avi|webm)($|\?)/i);
      containerParams.media_type = isVideo ? "VIDEO" : "IMAGE";
      if (isVideo) {
        containerParams.video_url = mediaUrl;
      } else {
        containerParams.image_url = mediaUrl;
      }
    } else if (payload.mediaUrls && payload.mediaUrls.length > 1) {
      // Carousel post: create individual containers first
      const childIds: string[] = [];
      for (const mediaUrl of payload.mediaUrls) {
        const isVideo = mediaUrl.match(/\.(mp4|mov|avi|webm)($|\?)/i);
        const childParams: Record<string, string> = {
          is_carousel_item: "true",
          access_token: tokens.accessToken,
          media_type: isVideo ? "VIDEO" : "IMAGE",
        };
        if (isVideo) {
          childParams.video_url = mediaUrl;
        } else {
          childParams.image_url = mediaUrl;
        }

        const childRes = await fetch(
          `https://graph.threads.net/v1.0/${userId}/threads`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(childParams),
          }
        );
        const childData: any = await childRes.json();
        if (!childRes.ok || childData.error) {
          throw new Error(`Threads carousel item creation failed: ${JSON.stringify(childData)}`);
        }
        childIds.push(childData.id);
      }

      containerParams.media_type = "CAROUSEL";
      containerParams.children = childIds.join(",");
    } else {
      containerParams.media_type = "TEXT";
    }

    const containerRes = await fetch(
      `https://graph.threads.net/v1.0/${userId}/threads`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(containerParams),
      }
    );

    const containerData: any = await containerRes.json();
    if (!containerRes.ok || containerData.error) {
      throw new Error(`Threads container creation failed: ${JSON.stringify(containerData)}`);
    }

    // Step 2: Publish the container
    const publishRes = await fetch(
      `https://graph.threads.net/v1.0/${userId}/threads_publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          creation_id: containerData.id,
          access_token: tokens.accessToken,
        }),
      }
    );

    const publishData: any = await publishRes.json();
    if (!publishRes.ok || publishData.error) {
      throw new Error(`Threads publish failed: ${JSON.stringify(publishData)}`);
    }

    // Get the permalink
    const permalinkRes = await fetch(
      `https://graph.threads.net/v1.0/${publishData.id}?fields=permalink&access_token=${tokens.accessToken}`
    );
    const permalinkData: any = await permalinkRes.json();

    return {
      platformPostId: publishData.id,
      url: permalinkData.permalink || `https://www.threads.net/post/${publishData.id}`,
      metadata: publishData,
    };
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    const res = await fetch(
      `https://graph.threads.net/v1.0/${platformPostId}?access_token=${tokens.accessToken}`,
      { method: "DELETE" }
    );

    if (!res.ok) {
      const data: any = await res.json();
      throw new Error(`Threads delete failed: ${JSON.stringify(data)}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const res = await fetch(
      `https://graph.threads.net/v1.0/me?fields=id,username,name,threads_profile_picture_url&access_token=${tokens.accessToken}`
    );

    const data: any = await res.json();
    if (!res.ok || data.error) throw new Error(`Threads profile fetch failed: ${JSON.stringify(data)}`);

    return {
      id: data.id,
      name: data.name || data.username,
      username: data.username,
      avatar: data.threads_profile_picture_url,
    };
  }

  async getPostAnalytics(tokens: OAuthTokens, platformPostId: string): Promise<SocialAnalytics | null> {
    const res = await fetch(
      `https://graph.threads.net/v1.0/${platformPostId}/insights?metric=views,likes,replies,reposts,quotes&access_token=${tokens.accessToken}`
    );

    const data: any = await res.json();
    if (!res.ok || data.error) return null;

    const metrics: Record<string, number> = {};
    if (data.data) {
      for (const metric of data.data) {
        metrics[metric.name] = metric.values?.[0]?.value || 0;
      }
    }

    const views = metrics.views || 0;
    const likes = metrics.likes || 0;
    const replies = metrics.replies || 0;
    const reposts = metrics.reposts || 0;
    const quotes = metrics.quotes || 0;

    return {
      impressions: views,
      clicks: 0,
      likes,
      shares: reposts + quotes,
      comments: replies,
      reach: views,
      engagementRate: views > 0 ? ((likes + replies + reposts + quotes) / views) * 100 : 0,
    };
  }
}
