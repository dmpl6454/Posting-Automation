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

export class RedditProvider extends SocialProvider {
  readonly platform: SocialPlatform = "REDDIT";
  readonly displayName = "Reddit";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 40000,
    supportedMediaTypes: ["image/jpeg", "image/png", "image/gif", "video/mp4"],
    maxMediaCount: 1,
    maxMediaSize: 20 * 1024 * 1024, // 20MB
  };

  private readonly userAgent = "PostAutomation/1.0.0";

  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      state,
      redirect_uri: config.callbackUrl,
      duration: "permanent",
      scope: config.scopes.join(" "),
    });
    return `https://www.reddit.com/api/v1/authorize?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        "User-Agent": this.userAgent,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.callbackUrl,
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Reddit token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: data.scope?.split(" "),
    };
  }

  async refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        "User-Agent": this.userAgent,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Reddit token refresh failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: refreshToken, // Reddit reuses the same refresh token
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const subreddit = (payload.metadata?.subreddit as string) || "u_me";
    const title = (payload.metadata?.title as string) || payload.content.slice(0, 300);

    // Determine post kind: link post if a URL is provided, otherwise self (text) post
    const linkUrl = payload.metadata?.linkUrl as string | undefined;
    const hasMedia = payload.mediaUrls && payload.mediaUrls.length > 0;

    const formParams: Record<string, string> = {
      api_type: "json",
      sr: subreddit,
      title,
      resubmit: "true",
    };

    if (linkUrl) {
      // Link post
      formParams.kind = "link";
      formParams.url = linkUrl;
    } else if (hasMedia) {
      // Image/media link post
      formParams.kind = "link";
      formParams.url = payload.mediaUrls![0]!;
    } else {
      // Self (text) post
      formParams.kind = "self";
      formParams.text = payload.content;
    }

    // If it's a link post and there's body text, add it via richtext or sendreplies
    if (formParams.kind === "link" && payload.content && !linkUrl) {
      // Content is used as the title already
    }

    const res = await fetch("https://oauth.reddit.com/api/submit", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.userAgent,
      },
      body: new URLSearchParams(formParams),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Reddit post failed: ${JSON.stringify(data)}`);

    // Reddit returns errors inside json.errors
    if (data.json?.errors?.length) {
      throw new Error(`Reddit post failed: ${JSON.stringify(data.json.errors)}`);
    }

    const postData = data.json?.data;
    return {
      platformPostId: postData?.name || postData?.id,
      url: postData?.url || `https://www.reddit.com${postData?.permalink || ""}`,
      metadata: postData,
    };
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    const res = await fetch("https://oauth.reddit.com/api/del", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.userAgent,
      },
      body: new URLSearchParams({ id: platformPostId }),
    });

    if (!res.ok) {
      const data: any = await res.json();
      throw new Error(`Reddit delete failed: ${JSON.stringify(data)}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const res = await fetch("https://oauth.reddit.com/api/v1/me", {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "User-Agent": this.userAgent,
      },
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Reddit profile fetch failed: ${JSON.stringify(data)}`);

    return {
      id: data.id,
      name: data.name,
      username: data.name,
      avatar: data.icon_img?.split("?")[0], // Strip query params from avatar URL
    };
  }

  async getPostAnalytics(tokens: OAuthTokens, platformPostId: string): Promise<SocialAnalytics | null> {
    // Fetch post details to get score, upvotes, comments
    const res = await fetch(
      `https://oauth.reddit.com/api/info?id=${platformPostId}`,
      {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "User-Agent": this.userAgent,
        },
      }
    );

    const data: any = await res.json();
    if (!res.ok) return null;

    const post = data.data?.children?.[0]?.data;
    if (!post) return null;

    const totalVotes = (post.ups || 0) + (post.downs || 0);
    return {
      impressions: post.view_count || 0,
      clicks: 0,
      likes: post.ups || 0,
      shares: post.crossposts?.length || 0,
      comments: post.num_comments || 0,
      reach: post.view_count || 0,
      engagementRate: totalVotes > 0
        ? ((post.ups || 0) + (post.num_comments || 0)) / totalVotes
        : 0,
    };
  }
}
