import type { SocialPlatform } from "@postautomation/db";
import { SocialProvider } from "../abstract/social.abstract";
import type {
  SocialPostPayload,
  SocialPostResult,
  OAuthTokens,
  OAuthConfig,
  SocialProfile,
  PlatformConstraints,
} from "../abstract/social.types";

export class WordPressProvider extends SocialProvider {
  readonly platform: SocialPlatform = "WORDPRESS";
  readonly displayName = "WordPress";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 100000,
    supportedMediaTypes: ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4"],
    maxMediaCount: 50,
  };

  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      response_type: "code",
      state,
      blog: "", // let user choose their site during auth
    });
    return `https://public-api.wordpress.com/oauth2/authorize?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch("https://public-api.wordpress.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.callbackUrl,
        code,
        grant_type: "authorization_code",
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`WordPress token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      // WordPress.com tokens don't expire by default, no refresh token
      refreshToken: undefined,
      expiresAt: undefined,
      scopes: ["global"],
      metadata: {
        blog_id: data.blog_id,
        blog_url: data.blog_url,
      },
    };
  }

  async refreshAccessToken(_refreshToken: string, _config: OAuthConfig): Promise<OAuthTokens> {
    // WordPress.com OAuth tokens don't expire — re-auth is needed if revoked
    throw new Error("WordPress.com tokens do not expire. Re-authorize if the token is revoked.");
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    // blog_id comes from channel metadata (stored during OAuth callback)
    const siteId = (payload.metadata as any)?.blog_id || tokens.metadata?.blog_id;
    if (!siteId) throw new Error("WordPress blog_id not found in channel metadata. Re-connect the channel.");

    // Upload media first if present
    const mediaIds: number[] = [];
    let featuredImageId: number | undefined;

    if (payload.mediaUrls?.length) {
      for (let i = 0; i < payload.mediaUrls.length; i++) {
        const url = payload.mediaUrls[i]!;
        const mediaRes = await this.uploadMediaFromUrl(tokens.accessToken, siteId, url);
        mediaIds.push(mediaRes.ID);
        if (i === 0) featuredImageId = mediaRes.ID;
      }
    }

    const title = (payload.metadata?.title as string) || (payload.content.split("\n")[0] ?? "").slice(0, 200);
    const status = (payload.metadata?.publishStatus as string) || "publish";
    const categories = (payload.metadata?.categories as string[]) || [];
    const tags = (payload.metadata?.tags as string[]) || [];
    const format = (payload.metadata?.format as string) || "standard";

    const body: Record<string, unknown> = {
      title,
      content: payload.content,
      status,
      format,
    };

    if (categories.length) body.categories_by_name = categories;
    if (tags.length) body.tags_by_name = tags;
    if (featuredImageId) body.featured_image = featuredImageId;
    if (mediaIds.length > 0) body.media_ids = mediaIds;

    const res = await fetch(`https://public-api.wordpress.com/rest/v1.2/sites/${siteId}/posts/new`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`WordPress post failed: ${JSON.stringify(data)}`);

    return {
      platformPostId: String(data.ID),
      url: data.URL || data.short_URL,
      metadata: {
        id: data.ID,
        slug: data.slug,
        status: data.status,
        site_ID: data.site_ID,
      },
    };
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string, metadata?: Record<string, unknown>): Promise<void> {
    const siteId = (metadata as any)?.blog_id || tokens.metadata?.blog_id;
    if (!siteId) throw new Error("WordPress blog_id not found in channel metadata.");

    const res = await fetch(
      `https://public-api.wordpress.com/rest/v1.2/sites/${siteId}/posts/${platformPostId}/delete`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }
    );

    if (!res.ok) {
      const data: any = await res.json();
      throw new Error(`WordPress delete failed: ${JSON.stringify(data)}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    // Get user info
    const userRes = await fetch("https://public-api.wordpress.com/rest/v1.1/me", {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const userData: any = await userRes.json();
    if (!userRes.ok) throw new Error(`WordPress profile fetch failed: ${JSON.stringify(userData)}`);

    // Try to get site info
    const siteId = tokens.metadata?.blog_id;
    let siteName = userData.display_name;
    let siteUrl = userData.primary_blog_url;
    let avatar = userData.avatar_URL;

    if (siteId) {
      try {
        const siteRes = await fetch(`https://public-api.wordpress.com/rest/v1.1/sites/${siteId}`, {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        });
        const siteData: any = await siteRes.json();
        if (siteRes.ok) {
          siteName = siteData.name || siteName;
          siteUrl = siteData.URL || siteUrl;
          avatar = siteData.icon?.img || avatar;
        }
      } catch {
        // Use user-level data as fallback
      }
    }

    return {
      id: String(userData.ID),
      name: siteName,
      username: siteUrl?.replace(/^https?:\/\//, "").replace(/\/$/, "") || userData.username,
      avatar,
    };
  }

  private async uploadMediaFromUrl(
    accessToken: string,
    siteId: string,
    mediaUrl: string
  ): Promise<{ ID: number; URL: string }> {
    const body = { media_urls: [mediaUrl] };

    const res = await fetch(`https://public-api.wordpress.com/rest/v1.2/sites/${siteId}/media/new`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`WordPress media upload failed: ${JSON.stringify(data)}`);

    const media = data.media?.[0];
    if (!media) throw new Error("WordPress media upload returned empty response");

    return { ID: media.ID, URL: media.URL };
  }
}
