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
    // Exchange authorization code for a short-lived token
    const params = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.callbackUrl,
      code,
    });

    const res = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/oauth/access_token?${params.toString()}`
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Facebook token exchange failed: ${JSON.stringify(data)}`);

    // Exchange short-lived token for a long-lived token
    const longLivedTokens = await this.exchangeForLongLivedToken(
      data.access_token,
      config.clientId,
      config.clientSecret
    );

    return longLivedTokens;
  }

  async refreshAccessToken(_refreshToken: string, config: OAuthConfig): Promise<OAuthTokens> {
    // Facebook does not use traditional refresh tokens.
    // Instead, exchange the existing long-lived token for a new long-lived token.
    // The _refreshToken parameter here is actually the current long-lived access token.
    const longLivedTokens = await this.exchangeForLongLivedToken(
      _refreshToken,
      config.clientId,
      config.clientSecret
    );

    return longLivedTokens;
  }

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    // When a page channel is used, the platformId IS the pageId and tokens.accessToken is the page token
    const pageId = (payload.metadata?.pageId as string) || (payload.metadata?.platformId as string) || "me";

    // If media URLs are provided, publish with photos
    if (payload.mediaUrls?.length) {
      return this.publishPostWithMedia(tokens, payload, pageId);
    }

    // Text-only post
    const res = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${pageId}/feed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: payload.content,
          access_token: tokens.accessToken,
        }),
      }
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
    const res = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}?access_token=${tokens.accessToken}`,
      { method: "DELETE" }
    );

    if (!res.ok) {
      const data: any = await res.json();
      throw new Error(`Facebook delete failed: ${JSON.stringify(data)}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const res = await fetch(
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

  /**
   * Fetch all Facebook Pages the user manages.
   * Returns page ID, name, picture, and the page-specific access token.
   */
  async getPages(tokens: OAuthTokens): Promise<Array<{
    id: string;
    name: string;
    avatar?: string;
    accessToken: string;
  }>> {
    const pages: Array<{ id: string; name: string; avatar?: string; accessToken: string }> = [];
    let url = `${this.graphBaseUrl}/${this.apiVersion}/me/accounts?fields=id,name,access_token&limit=25&access_token=${tokens.accessToken}`;

    while (url) {
      const res = await fetch(url);
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

      // Handle pagination
      url = data.paging?.next || "";
    }

    return pages;
  }

  async getPostAnalytics(tokens: OAuthTokens, platformPostId: string): Promise<SocialAnalytics | null> {
    const res = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}/insights?metric=post_impressions,post_clicks,post_reactions_like_total,post_engaged_users&access_token=${tokens.accessToken}`
    );

    const data: any = await res.json();
    if (!res.ok) return null;

    const metrics: Record<string, number> = {};
    if (data.data) {
      for (const metric of data.data) {
        metrics[metric.name] = metric.values?.[0]?.value || 0;
      }
    }

    // Fetch basic engagement counts from the post itself
    const postRes = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${platformPostId}?fields=shares,comments.summary(true),reactions.summary(true)&access_token=${tokens.accessToken}`
    );

    const postData: any = await postRes.json();
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

  /**
   * Exchange a short-lived or existing long-lived token for a new long-lived token.
   */
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

    const res = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/oauth/access_token?${params.toString()}`
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Facebook long-lived token exchange failed: ${JSON.stringify(data)}`);

    return {
      accessToken: data.access_token,
      // Facebook long-lived tokens last ~60 days; store the token itself as the refreshToken
      // so it can be exchanged again before expiry.
      refreshToken: data.access_token,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : undefined,
      scopes: data.token_type ? [data.token_type] : undefined,
    };
  }

  /**
   * Download a media file and return it as a Buffer with its content type.
   * This is needed because MinIO URLs are internal Docker hostnames that
   * external APIs (Facebook, etc.) cannot reach directly.
   * Falls back to URL extension detection when the server returns a generic
   * content-type (e.g. application/octet-stream from MinIO).
   */
  private async fetchMediaAsBuffer(mediaUrl: string): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
    const res = await fetch(mediaUrl);
    if (!res.ok) throw new Error(`Failed to fetch media from ${mediaUrl}: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    let contentType = res.headers.get("content-type") || "";

    // If server returns a generic content-type, detect from URL extension
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

  /**
   * Build a multipart/form-data body manually (avoids DOM FormData/Blob types
   * which are not in the ES2022-only TypeScript lib used by this package).
   */
  private buildMultipartBody(
    fields: Record<string, string>,
    file: { name: string; contentType: string; buffer: Buffer }
  ): { body: Uint8Array; contentType: string } {
    const boundary = `----FacebookUpload${Date.now()}`;
    const parts: Buffer[] = [];

    // Text fields
    for (const [key, value] of Object.entries(fields)) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      ));
    }

    // File field
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

  /**
   * Upload a single photo to Facebook using binary source (not URL).
   * Returns the photo ID.
   */
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

    const res = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${pageId}/photos`,
      {
        method: "POST",
        headers: { "Content-Type": multipartContentType },
        body: new Uint8Array(body),
      }
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Facebook photo post failed: ${JSON.stringify(data)}`);
    return data;
  }

  /**
   * Upload a video to Facebook using binary source.
   * Uses the /{page-id}/videos endpoint (not /photos).
   */
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

    const res = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${pageId}/videos`,
      {
        method: "POST",
        headers: { "Content-Type": multipartContentType },
        body: new Uint8Array(body),
      }
    );

    const data: any = await res.json();
    if (!res.ok) throw new Error(`Facebook video post failed: ${JSON.stringify(data)}`);
    return data;
  }

  /**
   * Publish a post with one or more media attachments (photos or video).
   * Downloads media server-side and uploads as binary to avoid
   * Facebook needing to fetch from internal MinIO URLs.
   */
  private async publishPostWithMedia(
    tokens: OAuthTokens,
    payload: SocialPostPayload,
    pageId: string
  ): Promise<SocialPostResult> {
    const mediaUrls = payload.mediaUrls!;

    // Detect if any media is a video
    const firstUrl = mediaUrls[0]!;
    const isVideo = /\.(mp4|mov|avi|mkv|webm)$/i.test(firstUrl) ||
      (payload.mediaTypes?.[0] ?? "").startsWith("video/");

    if (isVideo) {
      // Facebook only supports one video per post
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

    // Multi-photo: upload each as unpublished, then create a feed post
    const photoIds = await Promise.all(
      mediaUrls.map(async (url) => {
        const data = await this.uploadPhotoToFacebook(tokens, pageId, url, false);
        return data.id;
      })
    );

    const attachedMedia = photoIds.map((id) => ({ media_fbid: id }));
    const feedRes = await fetch(
      `${this.graphBaseUrl}/${this.apiVersion}/${pageId}/feed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: payload.content,
          access_token: tokens.accessToken,
          attached_media: attachedMedia,
        }),
      }
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
