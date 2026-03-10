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

export class YouTubeProvider extends SocialProvider {
  readonly platform: SocialPlatform = "YOUTUBE";
  readonly displayName = "YouTube";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 5000,
    supportedMediaTypes: ["video/mp4"],
    maxMediaCount: 1,
    maxMediaSize: 256 * 1024 * 1024, // 256MB
  };

  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      response_type: "code",
      scope: config.scopes.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.callbackUrl,
        grant_type: "authorization_code",
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`YouTube token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: data.scope?.split(" "),
    };
  }

  async refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`YouTube token refresh failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: refreshToken, // Google reuses the same refresh token
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    // If a video file URL is provided, upload it as a YouTube video
    if (payload.mediaUrls?.length) {
      return this.uploadVideo(tokens, payload);
    }

    // No video — create a community post via YouTube Data API activities.insert
    // Note: Community posts require the channel to have the Community tab enabled
    return this.createCommunityPost(tokens, payload);
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    // YouTube Data API: delete a video
    const params = new URLSearchParams({ id: platformPostId });
    const res = await fetch(
      `https://youtube.googleapis.com/youtube/v3/videos?${params.toString()}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }
    );

    if (!res.ok) {
      // YouTube returns 204 No Content on success; read body only on failure
      let errorBody = "";
      try {
        const data: any = await res.json();
        errorBody = JSON.stringify(data);
      } catch {
        errorBody = `HTTP ${res.status}`;
      }
      throw new Error(`YouTube delete failed: ${errorBody}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const params = new URLSearchParams({ part: "snippet", mine: "true" });
    const res = await fetch(
      `https://youtube.googleapis.com/youtube/v3/channels?${params.toString()}`,
      { headers: { Authorization: `Bearer ${tokens.accessToken}` } }
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`YouTube profile fetch failed: ${JSON.stringify(data)}`);

    const channel = data.items?.[0];
    if (!channel) throw new Error("YouTube profile fetch failed: no channel found");

    return {
      id: channel.id,
      name: channel.snippet.title,
      username: channel.snippet.customUrl,
      avatar: channel.snippet.thumbnails?.default?.url,
    };
  }

  async getPostAnalytics(tokens: OAuthTokens, platformPostId: string): Promise<SocialAnalytics | null> {
    const params = new URLSearchParams({
      part: "statistics",
      id: platformPostId,
    });
    const res = await fetch(
      `https://youtube.googleapis.com/youtube/v3/videos?${params.toString()}`,
      { headers: { Authorization: `Bearer ${tokens.accessToken}` } }
    );

    const data: any = await res.json();
    if (!res.ok) return null;

    const stats = data.items?.[0]?.statistics;
    if (!stats) return null;

    const views = parseInt(stats.viewCount || "0", 10);
    const likes = parseInt(stats.likeCount || "0", 10);
    const comments = parseInt(stats.commentCount || "0", 10);
    const favorites = parseInt(stats.favoriteCount || "0", 10);

    return {
      impressions: views,
      clicks: 0,
      likes,
      shares: favorites,
      comments,
      reach: views,
      engagementRate: views > 0 ? (likes + comments) / views : 0,
    };
  }

  private async uploadVideo(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const videoUrl = payload.mediaUrls![0]!;
    const title = (payload.metadata?.title as string) || payload.content.slice(0, 100);
    const description = payload.content;
    const tags = (payload.metadata?.tags as string[]) || [];
    const privacyStatus = (payload.metadata?.privacyStatus as string) || "public";
    const categoryId = (payload.metadata?.categoryId as string) || "22"; // 22 = People & Blogs

    // Download the video file
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) throw new Error(`Failed to download video from ${videoUrl}`);
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
    const videoContentType = videoRes.headers.get("content-type") || "video/mp4";

    // Step 1: Initiate resumable upload
    const metadata = {
      snippet: {
        title,
        description,
        tags,
        categoryId,
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: false,
      },
    };

    const uploadParams = new URLSearchParams({
      uploadType: "resumable",
      part: "snippet,status",
    });

    const initRes = await fetch(
      `https://www.googleapis.com/upload/youtube/v3/videos?${uploadParams.toString()}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": videoBuffer.length.toString(),
          "X-Upload-Content-Type": videoContentType,
        },
        body: JSON.stringify(metadata),
      }
    );

    if (!initRes.ok) {
      const data: any = await initRes.json();
      throw new Error(`YouTube upload init failed: ${JSON.stringify(data)}`);
    }

    const uploadUrl = initRes.headers.get("location");
    if (!uploadUrl) throw new Error("YouTube upload init failed: no upload URL returned");

    // Step 2: Upload the video bytes to the resumable upload URL
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": videoContentType,
        "Content-Length": videoBuffer.length.toString(),
      },
      body: videoBuffer,
    });

    const data: any = await uploadRes.json();
    if (!uploadRes.ok) throw new Error(`YouTube video upload failed: ${JSON.stringify(data)}`);

    return {
      platformPostId: data.id,
      url: `https://www.youtube.com/watch?v=${data.id}`,
      metadata: data,
    };
  }

  private async createCommunityPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    // YouTube Data API does not have a dedicated community post endpoint.
    // Use the activities.insert endpoint with a bulletin type for text-only posts.
    const profile = await this.getProfile(tokens);

    const body = {
      snippet: {
        channelId: profile.id,
        description: payload.content,
      },
      contentDetails: {
        bulletin: {
          resourceId: {
            kind: "youtube#channel",
            channelId: profile.id,
          },
        },
      },
    };

    const params = new URLSearchParams({ part: "snippet,contentDetails" });
    const res = await fetch(
      `https://youtube.googleapis.com/youtube/v3/activities?${params.toString()}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`YouTube community post failed: ${JSON.stringify(data)}`);

    return {
      platformPostId: data.id,
      url: `https://www.youtube.com/channel/${profile.id}/community?lb=${data.id}`,
      metadata: data,
    };
  }
}
