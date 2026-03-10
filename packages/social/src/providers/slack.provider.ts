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

export class SlackProvider extends SocialProvider {
  readonly platform: SocialPlatform = "SLACK";
  readonly displayName = "Slack";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 40000,
    supportedMediaTypes: ["image/jpeg", "image/png", "image/gif", "video/mp4"],
    maxMediaCount: 10,
    maxMediaSize: 1024 * 1024 * 1024, // 1GB
  };

  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      client_id: config.clientId,
      scope: config.scopes.join(","),
      redirect_uri: config.callbackUrl,
      state,
    });
    return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.callbackUrl,
      }),
    });

    const data: any = await res.json();
    if (!data.ok) throw new Error(`Slack token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token || data.authed_user?.access_token,
      refreshToken: data.refresh_token,
      scopes: data.scope?.split(","),
    };
  }

  /**
   * Slack tokens from V2 OAuth don't typically expire for bot tokens.
   * For user tokens with token rotation enabled, refresh is supported.
   */
  async refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch("https://slack.com/api/oauth.v2.access", {
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
    if (!data.ok) throw new Error(`Slack token refresh failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: data.exp ? new Date(data.exp * 1000) : undefined,
    };
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const channel = (payload.metadata?.channel as string) || (payload.metadata?.channelId as string);
    if (!channel) {
      throw new Error("Slack publishPost requires metadata.channel (channel ID)");
    }

    // If media is attached, upload files first and share them
    if (payload.mediaUrls?.length) {
      return this.postWithMedia(tokens, channel, payload);
    }

    // Text-only message
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel,
        text: payload.content,
        unfurl_links: true,
        unfurl_media: true,
      }),
    });

    const data: any = await res.json();
    if (!data.ok) throw new Error(`Slack postMessage failed: ${JSON.stringify(data)}`);

    return {
      platformPostId: data.ts,
      url: data.message?.permalink || `https://slack.com/archives/${channel}/p${data.ts.replace(".", "")}`,
      metadata: data.message,
    };
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    // platformPostId format: "channel:ts"
    const parts = platformPostId.split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error("Slack deletePost requires platformPostId in format 'channel:ts'");
    }
    const channel = parts[0];
    const ts = parts[1];

    const res = await fetch("https://slack.com/api/chat.delete", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, ts }),
    });

    const data: any = await res.json();
    if (!data.ok) throw new Error(`Slack delete failed: ${JSON.stringify(data)}`);
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    // Get bot/user identity
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
      },
    });

    const data: any = await res.json();
    if (!data.ok) throw new Error(`Slack auth.test failed: ${JSON.stringify(data)}`);

    // Try to get more profile info
    let avatar: string | undefined;
    if (data.user_id) {
      const userRes = await fetch(`https://slack.com/api/users.info?user=${data.user_id}`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      const userData: any = await userRes.json();
      if (userData.ok) {
        avatar = userData.user?.profile?.image_72;
      }
    }

    return {
      id: data.user_id || data.bot_id,
      name: data.user || data.bot_id,
      username: data.user,
      avatar,
    };
  }

  private async postWithMedia(
    tokens: OAuthTokens,
    channel: string,
    payload: SocialPostPayload
  ): Promise<SocialPostResult> {
    const mediaUrls = payload.mediaUrls!;

    // Upload each file and collect file IDs
    const fileIds: string[] = [];
    for (const url of mediaUrls) {
      const mediaRes = await fetch(url);
      const mediaBuffer = Buffer.from(await mediaRes.arrayBuffer());
      const contentType = mediaRes.headers.get("content-type") || "application/octet-stream";
      const ext = contentType.split("/")[1] || "bin";
      const filename = `upload.${ext}`;

      // Get upload URL
      const uploadRes = await fetch("https://slack.com/api/files.getUploadURLExternal", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          filename,
          length: String(mediaBuffer.length),
        }),
      });

      const uploadData: any = await uploadRes.json();
      if (!uploadData.ok) throw new Error(`Slack file upload URL failed: ${JSON.stringify(uploadData)}`);

      // Upload file to the URL
      await fetch(uploadData.upload_url, {
        method: "POST",
        body: mediaBuffer,
      });

      // Complete the upload
      const completeRes = await fetch("https://slack.com/api/files.completeUploadExternal", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          files: [{ id: uploadData.file_id, title: filename }],
          channel_id: channel,
          initial_comment: fileIds.length === 0 ? payload.content : undefined,
        }),
      });

      const completeData: any = await completeRes.json();
      if (!completeData.ok) throw new Error(`Slack file complete failed: ${JSON.stringify(completeData)}`);
      fileIds.push(uploadData.file_id);
    }

    // The first completeUploadExternal with initial_comment creates the message
    // Return a composite ID
    return {
      platformPostId: `${channel}:${fileIds[0]}`,
      url: `https://slack.com/archives/${channel}`,
      metadata: { fileIds },
    };
  }
}
