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

const DEFAULT_INSTANCE = "https://mastodon.social";

export class MastodonProvider extends SocialProvider {
  readonly platform: SocialPlatform = "MASTODON";
  readonly displayName = "Mastodon";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 500,
    supportedMediaTypes: ["image/jpeg", "image/png", "image/gif", "video/mp4"],
    maxMediaCount: 4,
    maxMediaSize: 16 * 1024 * 1024,
  };

  private getInstanceUrl(config?: OAuthConfig): string {
    const instance = (config as any)?.metadata?.instance as string | undefined;
    return instance || DEFAULT_INSTANCE;
  }

  private getInstanceFromToken(tokens: OAuthTokens): string {
    const instance = (tokens as any)?.metadata?.instance as string | undefined;
    return instance || DEFAULT_INSTANCE;
  }

  getOAuthUrl(config: OAuthConfig, state: string): string {
    const instance = this.getInstanceUrl(config);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      scope: config.scopes.join(" "),
      state,
    });
    return `${instance}/oauth/authorize?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    const instance = this.getInstanceUrl(config);
    const res = await fetch(`${instance}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.callbackUrl,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Mastodon token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : undefined,
      scopes: data.scope?.split(" "),
    };
  }

  async refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    const instance = this.getInstanceUrl(config);
    const res = await fetch(`${instance}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Mastodon token refresh failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : undefined,
    };
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const instance = this.getInstanceFromToken(tokens);

    // Upload media first if present
    let mediaIds: string[] = [];
    if (payload.mediaUrls?.length) {
      mediaIds = await Promise.all(
        payload.mediaUrls.map((url) => this.uploadMedia(tokens, instance, url))
      );
    }

    const body: Record<string, unknown> = {
      status: payload.content,
    };
    if (mediaIds.length > 0) {
      body.media_ids = mediaIds;
    }
    if (payload.metadata?.visibility) {
      body.visibility = payload.metadata.visibility;
    }
    if (payload.metadata?.spoilerText) {
      body.spoiler_text = payload.metadata.spoilerText;
    }

    const res = await fetch(`${instance}/api/v1/statuses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Mastodon post failed: ${JSON.stringify(data)}`);

    return {
      platformPostId: data.id,
      url: data.url,
      metadata: {
        createdAt: data.created_at,
        visibility: data.visibility,
      },
    };
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    const instance = this.getInstanceFromToken(tokens);
    const res = await fetch(`${instance}/api/v1/statuses/${platformPostId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!res.ok) {
      const data: any = await res.json();
      throw new Error(`Mastodon delete failed: ${JSON.stringify(data)}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const instance = this.getInstanceFromToken(tokens);
    const res = await fetch(`${instance}/api/v1/accounts/verify_credentials`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    const data: any = await res.json();
    if (!res.ok) throw new Error(`Mastodon profile fetch failed: ${JSON.stringify(data)}`);

    return {
      id: data.id,
      name: data.display_name || data.username,
      username: data.acct,
      avatar: data.avatar,
    };
  }

  private async uploadMedia(
    tokens: OAuthTokens,
    instance: string,
    mediaUrl: string
  ): Promise<string> {
    // Download the media file
    const mediaRes = await fetch(mediaUrl);
    const mediaBlob = await mediaRes.blob();
    const mediaType = mediaRes.headers.get("content-type") || "image/jpeg";

    // Build multipart form data for Mastodon media upload
    const formData = new FormData();
    formData.append("file", mediaBlob, `upload.${mediaType.split("/")[1] || "jpg"}`);

    const res = await fetch(`${instance}/api/v2/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      body: formData,
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Mastodon media upload failed: ${JSON.stringify(data)}`);
    return data.id;
  }
}
