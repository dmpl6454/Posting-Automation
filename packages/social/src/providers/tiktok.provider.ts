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

export class TikTokProvider extends SocialProvider {
  readonly platform: SocialPlatform = "TIKTOK";
  readonly displayName = "TikTok";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 2200,
    supportedMediaTypes: ["video/mp4"],
    maxMediaCount: 1,
    maxMediaSize: 287 * 1024 * 1024, // 287 MB
  };

  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      client_key: config.clientId,
      response_type: "code",
      scope: config.scopes.join(","),
      redirect_uri: config.callbackUrl,
      state,
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: config.clientId,
        client_secret: config.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: config.callbackUrl,
      }),
    });

    const data: any = await res.json();
    if (!res.ok || data.error) {
      throw new Error(`TikTok token exchange failed: ${JSON.stringify(data)}`);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: data.scope?.split(","),
    };
  }

  async refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    const data: any = await res.json();
    if (!res.ok || data.error) {
      throw new Error(`TikTok token refresh failed: ${JSON.stringify(data)}`);
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    if (!payload.mediaUrls?.length) {
      throw new Error("TikTok requires a video to publish a post");
    }

    const videoUrl = payload.mediaUrls[0]!;

    // Step 1: Download the video to get its size
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) {
      throw new Error(`Failed to download video from ${videoUrl}`);
    }
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
    const videoSize = videoBuffer.byteLength;

    // Step 2: Initialize video upload via pull-from-url
    const initBody = {
      post_info: {
        title: payload.content,
        privacy_level: (payload.metadata?.privacyLevel as string) || "SELF_ONLY",
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: "PULL_FROM_URL",
        video_url: videoUrl,
      },
    };

    const initRes = await fetch(
      "https://open.tiktokapis.com/v2/post/publish/video/init/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify(initBody),
      }
    );

    const initData: any = await initRes.json();
    if (!initRes.ok || initData.error?.code) {
      throw new Error(`TikTok video publish init failed: ${JSON.stringify(initData)}`);
    }

    const publishId = initData.data?.publish_id;
    if (!publishId) {
      throw new Error(`TikTok did not return a publish_id: ${JSON.stringify(initData)}`);
    }

    // Step 3: Poll for publish status
    const postId = await this.pollPublishStatus(tokens, publishId);

    return {
      platformPostId: postId,
      url: `https://www.tiktok.com/@me/video/${postId}`,
      metadata: { publish_id: publishId },
    };
  }

  async deletePost(_tokens: OAuthTokens, _platformPostId: string): Promise<void> {
    // TikTok Content Posting API does not provide a delete endpoint.
    // Videos can only be deleted by the user through the TikTok app.
    throw new Error(
      "TikTok API does not support deleting posts programmatically. " +
      "Users must delete videos directly through the TikTok app."
    );
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const res = await fetch(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,display_name,avatar_url",
      {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }
    );

    const data: any = await res.json();
    if (!res.ok || data.error?.code) {
      throw new Error(`TikTok profile fetch failed: ${JSON.stringify(data)}`);
    }

    const user = data.data?.user;
    return {
      id: user?.open_id || "",
      name: user?.display_name || "",
      username: user?.display_name,
      avatar: user?.avatar_url,
    };
  }

  /**
   * Polls the TikTok publish status endpoint until the video is published
   * or a terminal error state is reached.
   */
  private async pollPublishStatus(
    tokens: OAuthTokens,
    publishId: string,
    maxAttempts = 15,
    intervalMs = 5000
  ): Promise<string> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.sleep(intervalMs);

      const statusRes = await fetch(
        "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ publish_id: publishId }),
        }
      );

      const statusData: any = await statusRes.json();
      if (!statusRes.ok) {
        throw new Error(`TikTok publish status check failed: ${JSON.stringify(statusData)}`);
      }

      const status = statusData.data?.status;

      if (status === "PUBLISH_COMPLETE") {
        return statusData.data?.publicaly_available_post_id?.[0] || publishId;
      }

      if (status === "FAILED") {
        const reason = statusData.data?.fail_reason || "unknown";
        throw new Error(`TikTok video publish failed: ${reason}`);
      }

      // PROCESSING_UPLOAD or PROCESSING_DOWNLOAD — continue polling
    }

    throw new Error("TikTok video publish timed out after polling");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
