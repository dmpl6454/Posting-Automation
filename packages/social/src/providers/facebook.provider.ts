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

// ── Facebook API Usage Tracking ────────────────────────────────────────
// Facebook returns x-app-usage and x-page-usage headers as JSON:
//   { "call_count": 28, "total_cputime": 25, "total_time": 30 }
// Values are percentages — throttle when approaching 80%, pause at 95%.

interface FbUsageInfo {
  call_count: number;
  total_cputime: number;
  total_time: number;
}

const usageCache: {
  app: FbUsageInfo;
  page: Record<string, FbUsageInfo>;
  lastRequest: number;
} = {
  app: { call_count: 0, total_cputime: 0, total_time: 0 },
  page: {},
  lastRequest: 0,
};

// Minimum ms between sequential Graph API requests (soft spacing)
const MIN_REQUEST_GAP_MS = 300;

export class FacebookProvider extends SocialProvider {
  readonly platform: SocialPlatform = "FACEBOOK";
  readonly displayName = "Facebook";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 63206,
    supportedMediaTypes: ["image/jpeg", "image/png", "image/gif", "video/mp4"],
    maxMediaCount: 10,
    maxMediaSize: 10 * 1024 * 1024,
  };

  private readonly apiVersion = "v18.0";
  private readonly graphBaseUrl = "https://graph.facebook.com";

  // ── Rate-limit-aware fetch wrapper ───────────────────────────────────
  // Tracks usage headers, enforces spacing, auto-retries on 429/throttle.

  private async graphFetch(
    url: string,
    init: RequestInit = {},
    pageId?: string,
    retries = 3
  ): Promise<Response> {
    // Enforce minimum gap between requests
    const now = Date.now();
    const elapsed = now - usageCache.lastRequest;
    if (elapsed < MIN_REQUEST_GAP_MS) {
      await this.sleep(MIN_REQUEST_GAP_MS - elapsed);
    }

    // Pre-flight: if usage is high, add a proportional delay
    await this.throttleIfNeeded(pageId);

    usageCache.lastRequest = Date.now();
    const res = await fetch(url, init);

    // Parse and cache usage headers
    this.parseUsageHeaders(res, pageId);

    // Auto-retry on rate limit (HTTP 429 or Facebook error code 4/32/368)
    if ((res.status === 429 || res.status === 403) && retries > 0) {
      const body: any = await res.clone().json().catch(() => null);
      const errCode = body?.error?.code;
      if (res.status === 429 || errCode === 4 || errCode === 32 || errCode === 368) {
        const backoff = this.calculateBackoff(retries);
        console.log(`[Facebook] Rate limited (code=${errCode || res.status}), backing off ${backoff}ms (${retries} retries left)`);
        await this.sleep(backoff);
        return this.graphFetch(url, init, pageId, retries - 1);
      }
    }

    return res;
  }

  private parseUsageHeaders(res: Response, pageId?: string): void {
    try {
      const appUsage = res.headers.get("x-app-usage");
      if (appUsage) {
        usageCache.app = JSON.parse(appUsage);
      }
      const pageUsage = res.headers.get("x-page-usage");
      if (pageUsage && pageId) {
        usageCache.page[pageId] = JSON.parse(pageUsage);
      }
    } catch { /* ignore parse errors */ }
  }

  private getMaxUsage(pageId?: string): number {
    const appMax = Math.max(usageCache.app.call_count, usageCache.app.total_cputime, usageCache.app.total_time);
    const pageMax = pageId && usageCache.page[pageId]
      ? Math.max(usageCache.page[pageId].call_count, usageCache.page[pageId].total_cputime, usageCache.page[pageId].total_time)
      : 0;
    return Math.max(appMax, pageMax);
  }

  private async throttleIfNeeded(pageId?: string): Promise<void> {
    const usage = this.getMaxUsage(pageId);

    if (usage >= 95) {
      // Critical — pause 60s to let the window reset
      console.log(`[Facebook] Usage at ${usage}% — pausing 60s to avoid hard block`);
      await this.sleep(60_000);
    } else if (usage >= 80) {
      // High — add proportional delay (2-10s)
      const delay = Math.round(((usage - 80) / 15) * 8_000 + 2_000);
      console.log(`[Facebook] Usage at ${usage}% — throttling ${delay}ms`);
      await this.sleep(delay);
    } else if (usage >= 60) {
      // Moderate — small delay (500-2000ms)
      const delay = Math.round(((usage - 60) / 20) * 1_500 + 500);
      await this.sleep(delay);
    }
    // Below 60% — no throttle, just the MIN_REQUEST_GAP_MS spacing
  }

  private calculateBackoff(retriesLeft: number): number {
    // Exponential backoff: 30s, 60s, 120s (based on retries remaining)
    const attempt = 4 - retriesLeft;
    return Math.min(30_000 * Math.pow(2, attempt - 1), 120_000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── OAuth ────────────────────────────────────────────────────────────

  getOAuthUrl(config: OAuthConfig, state: string): string {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      scope: config.scopes.join(","),
      state,
      response_type: "code",
    });
    return `https://www.facebook.com/${this.apiVersion}/dialog/oauth?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string, config: OAuthConfig): Promise<OAuthTokens> {
    const params = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.callbackUrl,
      code,
    });

    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/oauth/access_token?${params.toString()}`
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Facebook token exchange failed: ${JSON.stringify(data)}`);

    const longLivedTokens = await this.exchangeForLongLivedToken(
      data.access_token,
      config.clientId,
      config.clientSecret
    );

    return longLivedTokens;
  }

  async refreshAccessToken(_refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    const longLivedTokens = await this.exchangeForLongLivedToken(
      _refreshToken,
      config.clientId,
      config.clientSecret
    );

    return longLivedTokens;
  }

  // ── Publishing ───────────────────────────────────────────────────────

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const pageId = (payload.metadata?.pageId as string) || (payload.metadata?.platformId as string) || "me";

    if (payload.mediaUrls?.length) {
      return this.publishPostWithMedia(tokens, payload, pageId);
    }

    // Text-only post
    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${pageId}/feed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: payload.content,
          access_token: tokens.accessToken,
        }),
      },
      pageId
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Facebook post failed: ${JSON.stringify(data)}`);

    return {
      platformPostId: data.id,
      url: `https://www.facebook.com/${data.id.replace("_", "/posts/")}`,
      metadata: data,
    };
  }

  async deletePost(tokens: OAuthTokens, platformPostId: string): Promise<void> {
    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}?access_token=${tokens.accessToken}`,
      { method: "DELETE" }
    );

    if (!res.ok) {
      const data: any = await res.json();
      throw new Error(`Facebook delete failed: ${JSON.stringify(data)}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/me?fields=id,name,picture&access_token=${tokens.accessToken}`
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Facebook profile fetch failed: ${JSON.stringify(data)}`);

    return {
      id: data.id,
      name: data.name,
      avatar: data.picture?.data?.url,
    };
  }

  async getPages(tokens: OAuthTokens): Promise<Array<{
    id: string;
    name: string;
    avatar?: string;
    accessToken: string;
  }>> {
    const pages: Array<{ id: string; name: string; avatar?: string; accessToken: string }> = [];
    let url: string | null = `${this.graphBaseUrl}/${this.apiVersion}/me/accounts?fields=id,name,access_token&limit=25&access_token=${tokens.accessToken}`;

    while (url) {
      const res = await this.graphFetch(url);
      const data: any = await res.json();
      if (!res.ok) throw new Error(`Facebook pages fetch failed: ${JSON.stringify(data)}`);

      if (data.data) {
        for (const page of data.data) {
          pages.push({
            id: page.id,
            name: page.name,
            accessToken: page.access_token,
          });
        }
      }

      url = data.paging?.next || null;
    }

    return pages;
  }

  async getPostAnalytics(tokens: OAuthTokens, platformPostId: string): Promise<SocialAnalytics | null> {
    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}/insights?metric=post_impressions,post_clicks,post_reactions_like_total,post_engaged_users&access_token=${tokens.accessToken}`
    );

    const data: any = await res.json();
    if (!res.ok) {
      console.warn(`[Facebook] getPostAnalytics failed for ${platformPostId}: ${JSON.stringify(data)}`);
    }

    const metrics: Record<string, number> = {};
    if (data.data) {
      for (const metric of data.data) {
        metrics[metric.name] = metric.values?.[0]?.value || 0;
      }
    }

    const postRes = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}?fields=shares,comments.summary(true),reactions.summary(true)&access_token=${tokens.accessToken}`
    );

    const postData: any = await postRes.json();
    if (!postRes.ok) {
      console.warn(`[Facebook] post fields fetch failed for ${platformPostId}: ${JSON.stringify(postData)}`);
      return null;
    }
    const shares = postData.shares?.count || 0;
    const comments = postData.comments?.summary?.total_count || 0;
    const reactions = postData.reactions?.summary?.total_count || 0;

    const impressions = metrics.post_impressions || 0;
    const totalEngagement = reactions + shares + comments;
    const engagementRate = impressions > 0 ? totalEngagement / impressions : 0;

    return {
      impressions,
      clicks: metrics.post_clicks || 0,
      likes: reactions,
      shares,
      comments,
      reach: metrics.post_engaged_users || 0,
      engagementRate,
    };
  }

  // ── Token management ─────────────────────────────────────────────────

  private async exchangeForLongLivedToken(
    accessToken: string,
    clientId: string,
    clientSecret: string
  ): Promise<OAuthTokens> {
    const params = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: clientId,
      client_secret: clientSecret,
      fb_exchange_token: accessToken,
    });

    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/oauth/access_token?${params.toString()}`
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Facebook long-lived token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      refreshToken: data.access_token,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : undefined,
      scopes: data.token_type ? [data.token_type] : undefined,
    };
  }

  // ── Media helpers ────────────────────────────────────────────────────

  private async fetchMediaAsBuffer(mediaUrl: string): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
    const res = await fetch(mediaUrl);
    if (!res.ok) throw new Error(`Failed to fetch media from ${mediaUrl}: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    let contentType = res.headers.get("content-type") || "";

    if (!contentType || contentType.startsWith("application/octet-stream") || contentType.startsWith("binary/")) {
      const urlPath = mediaUrl.split("?")[0] ?? "";
      const urlExt = urlPath.split(".").pop()?.toLowerCase() ?? "";
      const mimeMap: Record<string, string> = {
        mp4: "video/mp4",
        mov: "video/quicktime",
        webm: "video/webm",
        avi: "video/avi",
        mkv: "video/x-matroska",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
      };
      contentType = mimeMap[urlExt] || "image/jpeg";
    }

    const ext = contentType.split("/")[1]?.split(";")[0] ?? "jpg";
    const fileExt = ext === "jpeg" ? "jpg" : ext === "quicktime" ? "mov" : ext;
    return { buffer, contentType, fileName: `upload.${fileExt}` };
  }

  private buildMultipartBody(
    fields: Record<string, string>,
    file: { name: string; contentType: string; buffer: Buffer }
  ): { body: Uint8Array; contentType: string } {
    const boundary = `----FacebookUpload${Date.now()}`;
    const parts: Buffer[] = [];

    for (const [key, value] of Object.entries(fields)) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      ));
    }

    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="${file.name}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
    ));
    parts.push(file.buffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    return {
      body: Buffer.concat(parts),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  // ── Photo/video uploads ──────────────────────────────────────────────

  private async uploadPhotoToFacebook(
    tokens: OAuthTokens,
    pageId: string,
    mediaUrl: string,
    published: boolean,
    message?: string
  ): Promise<{ id: string; post_id?: string }> {
    const { buffer, contentType, fileName } = await this.fetchMediaAsBuffer(mediaUrl);

    const fields: Record<string, string> = {
      access_token: tokens.accessToken,
      published: String(published),
    };
    if (message) fields["message"] = message;

    const { body, contentType: multipartContentType } = this.buildMultipartBody(fields, { name: fileName, contentType, buffer });

    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${pageId}/photos`,
      {
        method: "POST",
        headers: { "Content-Type": multipartContentType },
        body: new Uint8Array(body),
      },
      pageId
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Facebook photo post failed: ${JSON.stringify(data)}`);
    return data;
  }

  private async uploadVideoToFacebook(
    tokens: OAuthTokens,
    pageId: string,
    mediaUrl: string,
    message?: string
  ): Promise<{ id: string; post_id?: string }> {
    const { buffer, contentType, fileName } = await this.fetchMediaAsBuffer(mediaUrl);

    const fields: Record<string, string> = {
      access_token: tokens.accessToken,
    };
    if (message) fields["description"] = message;

    const { body, contentType: multipartContentType } = this.buildMultipartBody(
      fields,
      { name: fileName, contentType, buffer }
    );

    const res = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${pageId}/videos`,
      {
        method: "POST",
        headers: { "Content-Type": multipartContentType },
        body: new Uint8Array(body),
      },
      pageId
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Facebook video post failed: ${JSON.stringify(data)}`);
    return data;
  }

  // ── Publish with media ───────────────────────────────────────────────

  private async publishPostWithMedia(
    tokens: OAuthTokens,
    payload: SocialPostPayload,
    pageId: string
  ): Promise<SocialPostResult> {
    const mediaUrls = payload.mediaUrls!;

    const firstUrl = mediaUrls[0]!;
    const isVideo = /\.(mp4|mov|avi|mkv|webm)$/i.test(firstUrl) ||
      (payload.mediaTypes?.[0] ?? "").startsWith("video/");

    if (isVideo) {
      const data = await this.uploadVideoToFacebook(tokens, pageId, firstUrl, payload.content);
      const postId = data.post_id || data.id;
      return {
        platformPostId: postId,
        url: `https://www.facebook.com/${postId.replace("_", "/posts/")}`,
        metadata: data,
      };
    }

    if (mediaUrls.length === 1) {
      const data = await this.uploadPhotoToFacebook(tokens, pageId, firstUrl, true, payload.content);
      const postId = data.post_id || data.id;
      return {
        platformPostId: postId,
        url: `https://www.facebook.com/${postId.replace("_", "/posts/")}`,
        metadata: data,
      };
    }

    // Multi-photo: upload sequentially with spacing to stay under rate limits
    // (parallel uploads burn through the call budget fast)
    const photoIds: string[] = [];
    for (const url of mediaUrls) {
      const data = await this.uploadPhotoToFacebook(tokens, pageId, url, false);
      photoIds.push(data.id);
    }

    const attachedMedia = photoIds.map((id) => ({ media_fbid: id }));
    const feedRes = await this.graphFetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${pageId}/feed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: payload.content,
          access_token: tokens.accessToken,
          attached_media: attachedMedia,
        }),
      },
      pageId
    );

    const feedData: any = await feedRes.json();
    if (!feedRes.ok) throw new Error(`Facebook multi-photo post failed: ${JSON.stringify(feedData)}`);

    return {
      platformPostId: feedData.id,
      url: `https://www.facebook.com/${feedData.id.replace("_", "/posts/")}`,
      metadata: feedData,
    };
  }
}
