import crypto from "node:crypto";
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

  // ---------------------------------------------------------------------------
  // OAuth 1.0a helpers
  // ---------------------------------------------------------------------------

  /** Build the base set of OAuth 1.0a params (nonce, timestamp, etc.) */
  private oAuth1aParams(extras: Record<string, string> = {}): Record<string, string> {
    return {
      oauth_consumer_key: process.env.TWITTER_CLIENT_ID ?? "",
      oauth_nonce: crypto.randomBytes(16).toString("hex"),
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_version: "1.0",
      ...extras,
    };
  }

  /**
   * Generate an HMAC-SHA1 OAuth 1.0a signature.
   * queryParams are included in the signature for GET requests.
   * Body params are NOT included for multipart or JSON bodies.
   */
  private signOAuth1a(
    method: string,
    baseUrl: string,
    oauthParams: Record<string, string>,
    queryParams: Record<string, string> = {},
    tokenSecret = ""
  ): string {
    const consumerSecret = process.env.TWITTER_CLIENT_SECRET ?? "";
    const allParams = { ...oauthParams, ...queryParams };

    const paramStr = Object.entries(allParams)
      .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");

    const baseString = [
      method.toUpperCase(),
      encodeURIComponent(baseUrl),
      encodeURIComponent(paramStr),
    ].join("&");

    const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;
    return crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
  }

  /** Build the OAuth Authorization header string from a params map. */
  private oAuth1aHeader(params: Record<string, string>): string {
    const fields = Object.entries(params)
      .filter(([k]) => k.startsWith("oauth_"))
      .map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`)
      .join(", ");
    return `OAuth ${fields}`;
  }

  /**
   * One-shot helper: build params, sign, and return the Authorization header.
   * Use this for any signed API request.
   */
  private signedAuthHeader(
    method: string,
    url: string,
    extraOAuthParams: Record<string, string> = {},
    queryParams: Record<string, string> = {},
    tokenSecret = ""
  ): string {
    const params = this.oAuth1aParams(extraOAuthParams);
    const sig = this.signOAuth1a(method, url, params, queryParams, tokenSecret);
    return this.oAuth1aHeader({ ...params, oauth_signature: sig });
  }

  // ---------------------------------------------------------------------------
  // OAuth flow — 3-legged OAuth 1.0a
  // ---------------------------------------------------------------------------

  async getOAuthUrl(config: OAuthConfig, state: string): Promise<string> {
    // Encode our state in the callback URL — Twitter preserves query params
    const callbackWithState = `${config.callbackUrl}?twitterstate=${encodeURIComponent(state)}`;

    const params = this.oAuth1aParams({ oauth_callback: callbackWithState });
    const sig = this.signOAuth1a("POST", "https://api.twitter.com/oauth/request_token", params, {}, "");
    const authHeader = this.oAuth1aHeader({ ...params, oauth_signature: sig });

    const res = await fetch("https://api.twitter.com/oauth/request_token", {
      method: "POST",
      headers: { Authorization: authHeader },
    });

    const body = await res.text();
    if (!res.ok) throw new Error(`Twitter OAuth request token failed (${res.status}): ${body}`);

    const rp = new URLSearchParams(body);
    const requestToken = rp.get("oauth_token");
    const requestTokenSecret = rp.get("oauth_token_secret");

    if (!requestToken || !requestTokenSecret) {
      throw new Error(`Twitter OAuth request token response invalid: ${body}`);
    }

    // Store the secret temporarily — retrieved in exchangeCodeForTokens
    storeRequestTokenSecret(requestToken, requestTokenSecret);

    return `https://api.twitter.com/oauth/authorize?oauth_token=${requestToken}`;
  }

  /**
   * Exchange the OAuth verifier for access tokens.
   * For OAuth 1.0a:
   *   code        = oauth_verifier  (from callback query param)
   *   codeVerifier = oauth_token    (request token; used to look up stored secret)
   */
  async exchangeCodeForTokens(
    oauthVerifier: string,
    _config: OAuthConfig,
    requestToken?: string
  ): Promise<OAuthTokens> {
    if (!requestToken) {
      throw new Error("Twitter OAuth 1.0a requires the oauth_token (request token) as codeVerifier.");
    }

    const requestTokenSecret = getAndDeleteRequestTokenSecret(requestToken);
    if (!requestTokenSecret) {
      throw new Error(
        "Twitter OAuth 1.0a: request token secret not found or expired. Please try connecting again."
      );
    }

    const params = this.oAuth1aParams({
      oauth_token: requestToken,
      oauth_verifier: oauthVerifier,
    });
    const sig = this.signOAuth1a(
      "POST",
      "https://api.twitter.com/oauth/access_token",
      params,
      {},
      requestTokenSecret
    );
    const authHeader = this.oAuth1aHeader({ ...params, oauth_signature: sig });

    const res = await fetch("https://api.twitter.com/oauth/access_token", {
      method: "POST",
      headers: { Authorization: authHeader },
    });

    const body = await res.text();
    if (!res.ok) throw new Error(`Twitter OAuth access token exchange failed (${res.status}): ${body}`);

    const rp = new URLSearchParams(body);
    const accessToken = rp.get("oauth_token");
    const tokenSecret = rp.get("oauth_token_secret");

    if (!accessToken || !tokenSecret) {
      throw new Error(`Twitter OAuth access token response invalid: ${body}`);
    }

    // Store the token secret in refreshToken field — OAuth 1.0a tokens never expire
    return {
      accessToken,
      refreshToken: tokenSecret,
    };
  }

  async refreshAccessToken(_refreshToken: string, _config: OAuthConfig): Promise<OAuthTokens> {
    // OAuth 1.0a tokens do not expire — no refresh needed
    throw new Error("Twitter OAuth 1.0a tokens do not expire and do not need refreshing.");
  }

  // ---------------------------------------------------------------------------
  // Publishing
  // ---------------------------------------------------------------------------

  async publishPost(tokens: OAuthTokens, payload: SocialPostPayload): Promise<SocialPostResult> {
    const tokenSecret = tokens.refreshToken ?? "";

    let mediaIds: string[] = [];
    if (payload.mediaUrls?.length) {
      const results = await Promise.allSettled(
        payload.mediaUrls.map((url) => this.uploadMedia(tokens, url))
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          mediaIds.push(r.value);
        } else {
          console.warn(`[Twitter] Media upload skipped (posting text-only): ${(r as PromiseRejectedResult).reason?.message}`);
        }
      }
    }

    const body: Record<string, unknown> = { text: payload.content };
    if (mediaIds.length > 0) {
      body.media = { media_ids: mediaIds };
    }

    const tweetUrl = "https://api.twitter.com/2/tweets";
    const authHeader = this.signedAuthHeader(
      "POST",
      tweetUrl,
      { oauth_token: tokens.accessToken },
      {},
      tokenSecret
    );

    const res = await fetch(tweetUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
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
    const tokenSecret = tokens.refreshToken ?? "";
    const deleteUrl = `https://api.twitter.com/2/tweets/${platformPostId}`;
    const authHeader = this.signedAuthHeader(
      "DELETE",
      deleteUrl,
      { oauth_token: tokens.accessToken },
      {},
      tokenSecret
    );

    const res = await fetch(deleteUrl, {
      method: "DELETE",
      headers: { Authorization: authHeader },
    });

    if (!res.ok) {
      const data: any = await res.json();
      throw new Error(`Twitter delete failed: ${JSON.stringify(data)}`);
    }
  }

  async getProfile(tokens: OAuthTokens): Promise<SocialProfile> {
    const tokenSecret = tokens.refreshToken ?? "";
    const profileUrl = "https://api.twitter.com/2/users/me";
    const query = { "user.fields": "profile_image_url,username" };
    const authHeader = this.signedAuthHeader(
      "GET",
      profileUrl,
      { oauth_token: tokens.accessToken },
      query,
      tokenSecret
    );

    const res = await fetch(
      `${profileUrl}?user.fields=profile_image_url,username`,
      { headers: { Authorization: authHeader } }
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
    const tokenSecret = tokens.refreshToken ?? "";
    const analyticsUrl = `https://api.twitter.com/2/tweets/${platformPostId}`;
    const query = { "tweet.fields": "public_metrics" };
    const authHeader = this.signedAuthHeader(
      "GET",
      analyticsUrl,
      { oauth_token: tokens.accessToken },
      query,
      tokenSecret
    );

    const res = await fetch(
      `${analyticsUrl}?tweet.fields=public_metrics`,
      { headers: { Authorization: authHeader } }
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

  // ---------------------------------------------------------------------------
  // Media upload — v1.1 with OAuth 1.0a signing
  // ---------------------------------------------------------------------------

  private async uploadMedia(tokens: OAuthTokens, mediaUrl: string): Promise<string> {
    const tokenSecret = tokens.refreshToken ?? "";

    const mediaRes = await fetch(mediaUrl);
    if (!mediaRes.ok) throw new Error(`Failed to fetch media for Twitter upload: ${mediaRes.status}`);
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

    const isVideo = mediaType.startsWith("video/");
    const mediaCategory = isVideo ? "tweet_video" : "tweet_image";

    const uploadUrl = "https://upload.twitter.com/1.1/media/upload.json";

    // For multipart form data, body params are NOT included in the OAuth 1.0a signature
    const authHeader = this.signedAuthHeader(
      "POST",
      uploadUrl,
      { oauth_token: tokens.accessToken },
      {},
      tokenSecret
    );

    const form = new FormData();
    form.append("media", new Blob([mediaBuffer], { type: mediaType }), "upload");
    form.append("media_category", mediaCategory);

    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: authHeader },
      body: form,
    });

    const text = await res.text();
    if (!text) {
      throw new Error(`Twitter media upload failed with HTTP ${res.status} (empty response body)`);
    }

    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Twitter media upload non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }

    if (!res.ok) {
      throw new Error(`Twitter media upload failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
    }

    return data.media_id_string ?? data.data?.id;
  }
}
