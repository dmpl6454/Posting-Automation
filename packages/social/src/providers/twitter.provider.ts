import crypto from "node:crypto";
import OAuth from "oauth-1.0a";
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
import {
  storeRequestTokenSecret,
  getAndDeleteRequestTokenSecret,
} from "../utils/oauth1a-temp-store";

export class TwitterProvider extends SocialProvider {
  readonly platform: SocialPlatform = "TWITTER";
  readonly displayName = "Twitter / X";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 280,
    supportedMediaTypes: ["image/jpeg", "image/png", "image/gif", "video/mp4"],
    maxMediaCount: 4,
    maxMediaSize: 5 * 1024 * 1024,
    supportsThreads: true,
  };

  /** Create an OAuth 1.0a client using the app's Consumer Key + Secret from env */
  private makeOAuth(tokenSecret = ""): OAuth {
    return new OAuth({
      consumer: {
        key: process.env.TWITTER_CLIENT_ID ?? "",
        secret: process.env.TWITTER_CLIENT_SECRET ?? "",
      },
      signature_method: "HMAC-SHA1",
      hash_function(baseString, key) {
        return crypto.createHmac("sha1", key).update(baseString).digest("base64");
      },
    });
  }

  /** Build the Authorization header for a request */
  private authHeader(
    method: string,
    url: string,
    data: Record<string, string> = {},
    token?: { key: string; secret: string }
  ): string {
    const oauth = this.makeOAuth();
    const requestData = { url, method, data };
    const authorized = token
      ? oauth.authorize(requestData, token)
      : oauth.authorize(requestData);
    return oauth.toHeader(authorized).Authorization;
  }

  // ---------------------------------------------------------------------------
  // OAuth flow — 3-legged OAuth 1.0a
  // ---------------------------------------------------------------------------

  async getOAuthUrl(config: OAuthConfig, state: string): Promise<string> {
    const callbackUrl = `${config.callbackUrl}?twitterstate=${encodeURIComponent(state)}`;

    const oauth = this.makeOAuth();
    const requestData = {
      url: "https://api.twitter.com/oauth/request_token",
      method: "POST",
      data: { oauth_callback: callbackUrl },
    };
    const header = oauth.toHeader(oauth.authorize(requestData));

    const res = await fetch("https://api.twitter.com/oauth/request_token", {
      method: "POST",
      headers: { Authorization: header.Authorization },
    });

    const body = await res.text();
    if (!res.ok) {
      console.error(`[Twitter] request_token failed HTTP ${res.status}: ${body}`);
      throw new Error(`Twitter OAuth request token failed (${res.status}): ${body}`);
    }

    const rp = new URLSearchParams(body);
    const requestToken = rp.get("oauth_token");
    const requestTokenSecret = rp.get("oauth_token_secret");

    if (!requestToken || !requestTokenSecret) {
      throw new Error(`Twitter OAuth request token response invalid: ${body}`);
    }

    storeRequestTokenSecret(requestToken, requestTokenSecret);
    return `https://api.twitter.com/oauth/authorize?oauth_token=${requestToken}`;
  }

  /**
   * Exchange the OAuth verifier for access tokens.
   *   code         = oauth_verifier  (from callback)
   *   codeVerifier = oauth_token     (request token — used to look up stored secret)
   */
  async exchangeCodeForTokens(
    oauthVerifier: string,
    _config: OAuthConfig,
    requestToken?: string
  ): Promise<OAuthTokens> {
    if (!requestToken) {
      throw new Error("Twitter OAuth 1.0a requires oauth_token as codeVerifier.");
    }

    const requestTokenSecret = getAndDeleteRequestTokenSecret(requestToken);
    if (!requestTokenSecret) {
      throw new Error(
        "Twitter OAuth 1.0a: request token secret not found or expired. Please try again."
      );
    }

    const oauth = this.makeOAuth();
    const token = { key: requestToken, secret: requestTokenSecret };
    const requestData = {
      url: "https://api.twitter.com/oauth/access_token",
      method: "POST",
      data: { oauth_verifier: oauthVerifier },
    };
    const header = oauth.toHeader(oauth.authorize(requestData, token));

    const res = await fetch("https://api.twitter.com/oauth/access_token", {
      method: "POST",
      headers: { Authorization: header.Authorization },
    });

    const body = await res.text();
    if (!res.ok) throw new Error(`Twitter OAuth access token exchange failed (${res.status}): ${body}`);

    const rp = new URLSearchParams(body);
    const accessToken = rp.get("oauth_token");
    const tokenSecret = rp.get("oauth_token_secret");

    if (!accessToken || !tokenSecret) {
      throw new Error(`Twitter OAuth access token response invalid: ${body}`);
    }

    // Store the token secret in refreshToken — OAuth 1.0a tokens never expire
    return { accessToken, refreshToken: tokenSecret };
  }

  async refreshAccessToken(_refreshToken: string, _config: OAuthConfig): Promise<OAuthTokens> {
    throw new Error("Twitter OAuth 1.0a tokens do not expire and do not need refreshing.");
  }

  // ---------------------------------------------------------------------------
  // Publishing
  // ---------------------------------------------------------------------------

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const token = { key: tokens.accessToken, secret: tokens.refreshToken ?? "" };

    let mediaIds: string[] = [];
    if (payload.mediaUrls?.length) {
      const results = await Promise.allSettled(
        payload.mediaUrls.map((url) => this.uploadMedia(token, url))
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          mediaIds.push(r.value);
        } else {
          console.warn(`[Twitter] Media upload skipped (text-only): ${(r as PromiseRejectedResult).reason?.message}`);
        }
      }
    }

    const body: Record<string, unknown> = { text: payload.content };
    if (mediaIds.length > 0) body.media = { media_ids: mediaIds };

    const tweetUrl = "https://api.twitter.com/2/tweets";
    const oauth = this.makeOAuth();
    const header = oauth.toHeader(oauth.authorize({ url: tweetUrl, method: "POST" }, token));

    const res = await fetch(tweetUrl, {
      method: "POST",
      headers: { Authorization: header.Authorization, "Content-Type": "application/json" },
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
    const token = { key: tokens.accessToken, secret: tokens.refreshToken ?? "" };
    const deleteUrl = `https://api.twitter.com/2/tweets/${platformPostId}`;
    const oauth = this.makeOAuth();
    const header = oauth.toHeader(oauth.authorize({ url: deleteUrl, method: "DELETE" }, token));

    const res = await fetch(deleteUrl, {
      method: "DELETE",
      headers: { Authorization: header.Authorization },
    });
    if (!res.ok) {
      const d: any = await res.json();
      throw new Error(`Twitter delete failed: ${JSON.stringify(d)}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const token = { key: tokens.accessToken, secret: tokens.refreshToken ?? "" };
    const profileUrl = "https://api.twitter.com/2/users/me?user.fields=profile_image_url,username";
    const oauth = this.makeOAuth();
    const header = oauth.toHeader(
      oauth.authorize({ url: profileUrl, method: "GET" }, token)
    );

    const res = await fetch(profileUrl, { headers: { Authorization: header.Authorization } });
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
    const token = { key: tokens.accessToken, secret: tokens.refreshToken ?? "" };
    const analyticsUrl = `https://api.twitter.com/2/tweets/${platformPostId}?tweet.fields=public_metrics`;
    const oauth = this.makeOAuth();
    const header = oauth.toHeader(oauth.authorize({ url: analyticsUrl, method: "GET" }, token));

    const res = await fetch(analyticsUrl, { headers: { Authorization: header.Authorization } });
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

  // ---------------------------------------------------------------------------
  // Media upload — v1.1 with OAuth 1.0a
  // ---------------------------------------------------------------------------

  private async uploadMedia(
    token: { key: string; secret: string },
    mediaUrl: string
  ): Promise<string> {
    const mediaRes = await fetch(mediaUrl);
    if (!mediaRes.ok) throw new Error(`Failed to fetch media for Twitter: ${mediaRes.status}`);
    const mediaBuffer = Buffer.from(await mediaRes.arrayBuffer());

    // Detect MIME type — fall back to URL extension if server returns generic type
    let mediaType = mediaRes.headers.get("content-type") ?? "";
    if (!mediaType || mediaType.startsWith("application/octet-stream")) {
      const [urlBase = ""] = mediaUrl.split("?");
      const urlExt = urlBase.split(".").pop()?.toLowerCase() ?? "";
      const mimeMap: Record<string, string> = {
        mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
        jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
        gif: "image/gif", webp: "image/webp",
      };
      mediaType = mimeMap[urlExt] ?? "image/jpeg";
    }

    const mediaCategory = mediaType.startsWith("video/") ? "tweet_video" : "tweet_image";
    const uploadUrl = "https://upload.twitter.com/1.1/media/upload.json";

    const oauth = this.makeOAuth();
    // For multipart uploads, body params are NOT included in OAuth signature
    const header = oauth.toHeader(oauth.authorize({ url: uploadUrl, method: "POST" }, token));

    const form = new FormData();
    form.append("media", new Blob([mediaBuffer], { type: mediaType }), "upload");
    form.append("media_category", mediaCategory);

    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: header.Authorization },
      body: form,
    });

    const text = await res.text();
    if (!text) throw new Error(`Twitter media upload HTTP ${res.status} (empty response)`);

    let data: any;
    try { data = JSON.parse(text); } catch {
      throw new Error(`Twitter media upload non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }

    if (!res.ok) throw new Error(`Twitter media upload failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
    return data.media_id_string ?? data.data?.id;
  }
}
