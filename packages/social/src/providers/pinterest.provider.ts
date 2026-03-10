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

export class PinterestProvider extends SocialProvider {
  readonly platform: SocialPlatform = "PINTEREST";
  readonly displayName = "Pinterest";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 500,
    supportedMediaTypes: ["image/jpeg", "image/png"],
    maxMediaCount: 1,
    maxMediaSize: 20 * 1024 * 1024, // 20 MB
  };

  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      response_type: "code",
      scope: config.scopes.join(","),
      state,
    });
    return `https://www.pinterest.com/oauth/?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch("https://api.pinterest.com/v5/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.callbackUrl,
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Pinterest token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      scopes: data.scope?.split(","),
    };
  }

  async refreshAccessToken(refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    const res = await fetch("https://api.pinterest.com/v5/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Pinterest token refresh failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const boardId = payload.metadata?.boardId as string | undefined;
    if (!boardId) {
      throw new Error("Pinterest requires a boardId in payload.metadata to create a pin");
    }

    const pinBody: Record<string, unknown> = {
      board_id: boardId,
      description: payload.content,
      title: (payload.metadata?.title as string) || "",
      link: (payload.metadata?.link as string) || undefined,
      alt_text: (payload.metadata?.altText as string) || "",
    };

    // Attach media source — image URL or base64
    if (payload.mediaUrls?.length) {
      pinBody.media_source = {
        source_type: "image_url",
        url: payload.mediaUrls[0],
      };
    }

    const res = await fetch("https://api.pinterest.com/v5/pins", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(pinBody),
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Pinterest pin creation failed: ${JSON.stringify(data)}`);

    return {
      platformPostId: data.id,
      url: `https://www.pinterest.com/pin/${data.id}/`,
      metadata: data,
    };
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    const res = await fetch(
      `https://api.pinterest.com/v5/pins/${platformPostId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }
    );
    if (!res.ok) {
      const data: any = await res.json();
      throw new Error(`Pinterest pin delete failed: ${JSON.stringify(data)}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const res = await fetch("https://api.pinterest.com/v5/user_account", {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Pinterest profile fetch failed: ${JSON.stringify(data)}`);

    return {
      id: data.username || data.id || "",
      name: data.business_name || data.username || "",
      username: data.username,
      avatar: data.profile_image,
    };
  }

  async getPostAnalytics(tokens: OAuthTokens, platformPostId: string): Promise<SocialAnalytics | null> {
    const res = await fetch(
      `https://api.pinterest.com/v5/pins/${platformPostId}/analytics?start_date=${this.getDateDaysAgo(30)}&end_date=${this.getToday()}&metric_types=IMPRESSION,PIN_CLICK,SAVE,OUTBOUND_CLICK`,
      { headers: { Authorization: `Bearer ${tokens.accessToken}` } }
    );

    const data: any = await res.json();
    if (!res.ok) return null;

    const all = data.all || {};
    const impressions = this.sumMetric(all.IMPRESSION);
    const clicks = this.sumMetric(all.PIN_CLICK) + this.sumMetric(all.OUTBOUND_CLICK);
    const saves = this.sumMetric(all.SAVE);

    return {
      impressions,
      clicks,
      likes: saves, // Pinterest uses "saves" instead of likes
      shares: 0,
      comments: 0,
      reach: impressions,
      engagementRate: impressions > 0 ? ((clicks + saves) / impressions) * 100 : 0,
    };
  }

  private sumMetric(metricObj: Record<string, number> | undefined): number {
    if (!metricObj) return 0;
    return Object.values(metricObj).reduce((sum, val) => sum + (val || 0), 0);
  }

  private getToday(): string {
    return new Date().toISOString().split("T")[0] ?? "";
  }

  private getDateDaysAgo(days: number): string {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString().split("T")[0] ?? "";
  }
}
