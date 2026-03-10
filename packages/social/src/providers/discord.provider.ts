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

export class DiscordProvider extends SocialProvider {
  readonly platform: SocialPlatform = "DISCORD";
  readonly displayName = "Discord";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 2000,
    supportedMediaTypes: ["image/jpeg", "image/png", "image/gif", "video/mp4"],
    maxMediaCount: 10,
    maxMediaSize: 25 * 1024 * 1024, // 25MB
  };

  private readonly API_BASE = "https://discord.com/api/v10";

  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      scope: config.scopes.join(" "),
      state,
    });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch(`${this.API_BASE}/oauth2/token`, {
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
    if (!res.ok) throw new Error(`Discord token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: data.scope?.split(" "),
    };
  }

  async refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch(`${this.API_BASE}/oauth2/token`, {
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
    if (!res.ok) throw new Error(`Discord token refresh failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const channelId = payload.metadata?.channelId as string;
    if (!channelId) {
      throw new Error("Discord publishPost requires metadata.channelId");
    }

    // Build the message body
    const body: Record<string, unknown> = {
      content: payload.content,
    };

    // If media URLs are present, attach them as embeds
    if (payload.mediaUrls?.length) {
      body.embeds = payload.mediaUrls.map((url) => ({
        image: { url },
      }));
    }

    const res = await fetch(`${this.API_BASE}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Discord post failed: ${JSON.stringify(data)}`);

    const guildId = data.guild_id;
    return {
      platformPostId: `${channelId}:${data.id}`,
      url: guildId
        ? `https://discord.com/channels/${guildId}/${channelId}/${data.id}`
        : `https://discord.com/channels/@me/${channelId}/${data.id}`,
      metadata: data,
    };
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    // platformPostId format: "channelId:messageId"
    const [channelId, messageId] = platformPostId.split(":");
    if (!channelId || !messageId) {
      throw new Error("Discord deletePost requires platformPostId in format 'channelId:messageId'");
    }

    const res = await fetch(
      `${this.API_BASE}/channels/${channelId}/messages/${messageId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }
    );

    if (!res.ok) {
      const data: any = await res.json();
      throw new Error(`Discord delete failed: ${JSON.stringify(data)}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const res = await fetch(`${this.API_BASE}/users/@me`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Discord profile fetch failed: ${JSON.stringify(data)}`);

    const avatarUrl = data.avatar
      ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png`
      : null;

    return {
      id: data.id,
      name: data.global_name || data.username,
      username: data.username,
      avatar: avatarUrl || undefined,
    };
  }
}
