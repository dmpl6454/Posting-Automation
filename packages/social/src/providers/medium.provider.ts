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

export class MediumProvider extends SocialProvider {
  readonly platform: SocialPlatform = "MEDIUM";
  readonly displayName = "Medium";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 100000,
    supportedMediaTypes: ["image/jpeg", "image/png", "image/gif"],
    maxMediaCount: 0, // Medium handles images inline in HTML/markdown content
  };

  /**
   * Medium uses integration tokens (self-issued tokens) rather than a standard OAuth flow.
   * We still provide the OAuth URL for their authorization page.
   */
  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      client_id: config.clientId,
      scope: config.scopes.join(","),
      state,
      response_type: "code",
      redirect_uri: config.callbackUrl,
    });
    return `https://medium.com/m/oauth/authorize?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch("https://api.medium.com/v1/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        redirect_uri: config.callbackUrl,
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Medium token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at ? new Date(data.expires_at * 1000) : undefined,
      scopes: data.scope?.split(","),
    };
  }

  async refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch("https://api.medium.com/v1/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Medium token refresh failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: data.expires_at ? new Date(data.expires_at * 1000) : undefined,
    };
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    // First, get the authenticated user's ID
    const profile = await this.getProfile(tokens);

    const contentFormat = (payload.metadata?.contentFormat as string) || "markdown";
    const publishStatus = (payload.metadata?.publishStatus as string) || "draft";
    const tags = (payload.metadata?.tags as string[]) || [];
    const canonicalUrl = payload.metadata?.canonicalUrl as string | undefined;

    const body: Record<string, unknown> = {
      title: (payload.metadata?.title as string) || (payload.content.split("\n")[0] ?? "").slice(0, 100),
      contentFormat,
      content: payload.content,
      publishStatus,
      tags: tags.slice(0, 5), // Medium allows max 5 tags
    };

    if (canonicalUrl) body.canonicalUrl = canonicalUrl;

    const res = await fetch(`https://api.medium.com/v1/users/${profile.id}/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Medium post failed: ${JSON.stringify(data)}`);

    return {
      platformPostId: data.data.id,
      url: data.data.url,
      metadata: data.data,
    };
  }

  /**
   * Medium API does not support deleting posts programmatically.
   * This method throws an error indicating the limitation.
   */
  async deletePost(_tokens: OAuthTokens, _platformPostId: string): Promise<void> {
    throw new Error("Medium API does not support deleting posts. Please delete manually at medium.com.");
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const res = await fetch("https://api.medium.com/v1/me", {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: "application/json",
      },
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Medium profile fetch failed: ${JSON.stringify(data)}`);

    return {
      id: data.data.id,
      name: data.data.name,
      username: data.data.username,
      avatar: data.data.imageUrl,
    };
  }
}
