import type { SocialPlatform } from "@postautomation/db";
import { SocialProvider } from "../abstract/social.abstract";
import { generateCodeVerifier, generateCodeChallenge } from "../utils/oauth-helper";
import type {
  SocialPostPayload,
  SocialPostResult,
  SocialAnalytics,
  OAuthTokens,
  OAuthConfig,
  SocialProfile,
  PlatformConstraints,
} from "../abstract/social.types";

export class TwitterProvider extends SocialProvider {
  readonly platform: SocialPlatform = "TWITTER";
  readonly displayName = "Twitter / X";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 280,
    supportedMediaTypes: ["image/jpeg", "image/png", "image/gif", "video/mp4"],
    maxMediaCount: 4,
    maxMediaSize: 5 * 1024 * 1024, // 5MB for images
    supportsThreads: true,
  };

  async getOAuthUrl(config: OAuthConfig, state: string): Promise<string> {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // Embed PKCE verifier in state so it survives the OAuth redirect roundtrip
    const stateWithPkce = `${state}|pkce:${codeVerifier}`;

    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      scope: config.scopes.join(" "),
      state: stateWithPkce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return `https://twitter.com/i/oauth2/authorize?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig, codeVerifier?: string): Promise<OAuthTokens> {
    const bodyParams: Record<string, string> = {
      code,
      grant_type: "authorization_code",
      redirect_uri: config.callbackUrl,
    };
    if (codeVerifier) {
      bodyParams.code_verifier = codeVerifier;
    }

    const res = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams(bodyParams),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Twitter token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: data.scope?.split(" "),
    };
  }

  async refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Twitter token refresh failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    // Upload media first if present
    let mediaIds: string[] = [];
    if (payload.mediaUrls?.length) {
      mediaIds = await Promise.all(
        payload.mediaUrls.map((url) => this.uploadMedia(tokens, url))
      );
    }

    const body: Record<string, unknown> = { text: payload.content };
    if (mediaIds.length > 0) {
      body.media = { media_ids: mediaIds };
    }

    const res = await fetch("https://api.twitter.com/2/tweets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Twitter post failed: ${JSON.stringify(data)}`);

    return {
      platformPostId: data.data.id,
      url: `https://twitter.com/i/status/${data.data.id}`,
      metadata: data.data,
    };
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    const res = await fetch(`https://api.twitter.com/2/tweets/${platformPostId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!res.ok) {
      const data: any = await res.json();
      throw new Error(`Twitter delete failed: ${JSON.stringify(data)}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const res = await fetch(
      "https://api.twitter.com/2/users/me?user.fields=profile_image_url,username",
      { headers: { Authorization: `Bearer ${tokens.accessToken}` } }
    );
    const data: any = await res.json();
    if (!res.ok) throw new Error(`Twitter profile fetch failed: ${JSON.stringify(data)}`);

    return {
      id: data.data.id,
      name: data.data.name,
      username: data.data.username,
      avatar: data.data.profile_image_url,
    };
  }

  async getPostAnalytics(tokens: OAuthTokens, platformPostId: string): Promise<SocialAnalytics | null> {
    const res = await fetch(
      `https://api.twitter.com/2/tweets/${platformPostId}?tweet.fields=public_metrics`,
      { headers: { Authorization: `Bearer ${tokens.accessToken}` } }
    );
    const data: any = await res.json();
    if (!res.ok) return null;

    const metrics = data.data?.public_metrics;
    if (!metrics) return null;

    return {
      impressions: metrics.impression_count || 0,
      clicks: 0,
      likes: metrics.like_count || 0,
      shares: metrics.retweet_count || 0,
      comments: metrics.reply_count || 0,
      reach: metrics.impression_count || 0,
      engagementRate: 0,
    };
  }

  private async uploadMedia(tokens: OAuthTokens, mediaUrl: string): Promise<string> {
    // Download the media file
    const mediaRes = await fetch(mediaUrl);
    const mediaBuffer = Buffer.from(await mediaRes.arrayBuffer());
    const mediaType = mediaRes.headers.get("content-type") || "image/jpeg";

    // Upload to Twitter media endpoint (v1.1 — still required for media uploads)
    const formData = new FormData();
    formData.append("media_data", mediaBuffer.toString("base64"));
    formData.append("media_category", mediaType.startsWith("video") ? "tweet_video" : "tweet_image");

    const res = await fetch("https://upload.twitter.com/1.1/media/upload.json", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      body: formData,
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Twitter media upload failed: ${JSON.stringify(data)}`);
    return data.media_id_string;
  }
}
