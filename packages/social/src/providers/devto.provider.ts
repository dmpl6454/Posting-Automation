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

export class DevtoProvider extends SocialProvider {
  readonly platform: SocialPlatform = "DEVTO";
  readonly displayName = "Dev.to";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 100000,
    supportedMediaTypes: [],
    maxMediaCount: 0, // Dev.to handles images inline in markdown
  };

  /**
   * Dev.to uses API keys rather than OAuth.
   * Direct user to settings page to generate an API key.
   */
  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      state,
      redirect_uri: config.callbackUrl,
    });
    return `https://dev.to/settings/extensions?${params.toString()}`;
  }

  /**
   * Dev.to uses API keys directly. The "code" here is the API key itself.
   * Validate it by calling the /users/me endpoint.
   */
  async exchangeCodeForTokens(code: string, _config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch("https://dev.to/api/users/me", {
      headers: { "api-key": code },
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Dev.to API key validation failed: ${JSON.stringify(data)}`);

    return {
      accessToken: code,
      // Dev.to API keys don't expire
    };
  }

  /**
   * Dev.to API keys don't expire, so refresh returns the same token.
   */
  async refreshAccessToken(refreshToken: string, _config: OAuthConfig): Promise<OAuthTokens> {
    return {
      accessToken: refreshToken,
    };
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const tags = (payload.metadata?.tags as string[]) || [];
    const series = payload.metadata?.series as string | undefined;
    const canonicalUrl = payload.metadata?.canonicalUrl as string | undefined;
    const published = payload.metadata?.published !== false; // default to published

    const article: Record<string, unknown> = {
      title: (payload.metadata?.title as string) || (payload.content.split("\n")[0] ?? "").slice(0, 100),
      body_markdown: payload.content,
      published,
      tags: tags.slice(0, 4), // Dev.to allows max 4 tags
    };

    if (series) article.series = series;
    if (canonicalUrl) article.canonical_url = canonicalUrl;

    const res = await fetch("https://dev.to/api/articles", {
      method: "POST",
      headers: {
        "api-key": tokens.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ article }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Dev.to post failed: ${JSON.stringify(data)}`);

    return {
      platformPostId: String(data.id),
      url: data.url,
      metadata: data,
    };
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    // Dev.to doesn't have a delete endpoint, but we can unpublish by setting published: false
    const res = await fetch(`https://dev.to/api/articles/${platformPostId}`, {
      method: "PUT",
      headers: {
        "api-key": tokens.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ article: { published: false } }),
    });

    if (!res.ok) {
      const data: any = await res.json();
      throw new Error(`Dev.to unpublish failed: ${JSON.stringify(data)}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const res = await fetch("https://dev.to/api/users/me", {
      headers: { "api-key": tokens.accessToken },
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Dev.to profile fetch failed: ${JSON.stringify(data)}`);

    return {
      id: String(data.id),
      name: data.name,
      username: data.username,
      avatar: data.profile_image,
    };
  }

  async getPostAnalytics(tokens: OAuthTokens, platformPostId: string): Promise<SocialAnalytics | null> {
    const res = await fetch(`https://dev.to/api/articles/${platformPostId}`, {
      headers: { "api-key": tokens.accessToken },
    });

    const data: any = await res.json();
    if (!res.ok) return null;

    const views = data.page_views_count || 0;
    const likes = data.positive_reactions_count || 0;
    const comments = data.comments_count || 0;

    return {
      impressions: views,
      clicks: 0,
      likes,
      shares: 0,
      comments,
      reach: views,
      engagementRate: views > 0 ? ((likes + comments) / views) * 100 : 0,
    };
  }
}
