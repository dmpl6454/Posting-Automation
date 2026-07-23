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
import { fetchT } from "../utils/fetch-timeout";
import { headRemoteMedia, fetchByteRange, computeByteRanges } from "../utils/ranged-media";

export class TwitterProvider extends SocialProvider {
  readonly platform: SocialPlatform = "TWITTER";
  readonly displayName = "Twitter / X";
  readonly constraints: PlatformConstraints = {
    maxContentLength: 25000, // X Premium supports up to 25,000 characters
    supportedMediaTypes: ["image/jpeg", "image/png", "image/gif", "video/mp4"],
    maxMediaCount: 4,
    maxMediaSize: 5 * 1024 * 1024,
    supportsThreads: true,
  };

  /** Create an OAuth 1.0a client using the app's Consumer Key + Secret from env */
  private makeOAuth(tokenSecret = ""): OAuth {
    const key = process.env.TWITTER_CLIENT_ID;
    const secret = process.env.TWITTER_CLIENT_SECRET;
    if (!key || !secret) {
      throw new Error(
        "TWITTER_CLIENT_ID / TWITTER_CLIENT_SECRET are not configured"
      );
    }
    return new OAuth({
      consumer: { key, secret },
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

    const res = await fetchT("https://api.twitter.com/oauth/request_token", {
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

    const res = await fetchT("https://api.twitter.com/oauth/access_token", {
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

    const mediaIds: string[] = [];
    if (payload.mediaUrls?.length) {
      const results = await Promise.allSettled(
        payload.mediaUrls.map((url) => this.uploadMedia(token, url, payload.onProgress))
      );
      const rejections: Array<{ index: number; reason: any }> = [];
      results.forEach((r, i) => {
        if (r.status === "fulfilled") mediaIds.push(r.value);
        else rejections.push({ index: i, reason: r.reason });
      });
      if (rejections.length > 0) {
        const videoFailed = rejections.some((rej) => {
          const declared = payload.mediaTypes?.[rej.index];
          if (declared?.startsWith("video/")) return true;
          // Fallback when mediaTypes is absent: URL extension sniff (same map uploadMedia uses)
          const [base = ""] = (payload.mediaUrls![rej.index] ?? "").split("?");
          return /\.(mp4|mov|webm)$/i.test(base);
        });
        // Hard-fail when (a) ALL intended media failed, or (b) any VIDEO failed —
        // a media post must never silently publish as a bare caption, and a video
        // post must never silently degrade to text/image-only. Throwing routes
        // into the worker's classify → FAILED-with-retry machinery (no tweet
        // exists yet, so retries are safe). Partial IMAGE failures keep the
        // historical lenient path.
        if (mediaIds.length === 0 || videoFailed) {
          const first = rejections[0]!.reason;
          throw new Error(
            `Twitter media upload failed (${rejections.length}/${payload.mediaUrls.length}): ${first?.message ?? String(first)}`
          );
        }
        for (const rej of rejections) {
          console.warn(`[Twitter] Image upload skipped: ${rej.reason?.message}`);
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

    const res = await fetchT(profileUrl, { headers: { Authorization: header.Authorization } });
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
    if (!res.ok) {
      console.warn(`[Twitter] getPostAnalytics failed for ${platformPostId}: ${JSON.stringify(data)}`);
      return null;
    }

    const metrics = data.data?.public_metrics;
    if (!metrics) {
      console.warn(`[Twitter] No public_metrics in response for ${platformPostId}: ${JSON.stringify(data)}`);
      return null;
    }

    return {
      impressions: metrics.impression_count || 0,
      clicks: 0,
      likes: metrics.like_count || 0,
      shares: metrics.retweet_count || 0,
      comments: metrics.reply_count || 0,
      reach: metrics.impression_count || 0,
      engagementRate: 0,
      likeKind: "likes",
      reachIsDistinct: false, // reach aliased from impression_count
      source: "api",
      // Free tier zeroes most metrics; clicks/reach are not real distinct values.
      metricsAvailable: { clicks: false, reach: false },
    };
  }

  // ---------------------------------------------------------------------------
  // Media upload — v1.1 with OAuth 1.0a
  // Images: simple multipart upload
  // Videos: chunked upload (INIT → APPEND → FINALIZE → STATUS poll)
  // ---------------------------------------------------------------------------

  private async uploadMedia(
    token: { key: string; secret: string },
    mediaUrl: string,
    onProgress?: (percent: number) => void | Promise<void>
  ): Promise<string> {
    // Probe type/size WITHOUT downloading (Phase 4 large-video streaming) —
    // videos are chunk-fetched via Range requests inside uploadVideoChunked,
    // so worker memory stays O(chunk) instead of O(file).
    const remote = await headRemoteMedia(mediaUrl);

    // Detect MIME type — fall back to URL extension if server returns generic type
    let mediaType = remote.contentType;
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

    if (isVideo) {
      return this.uploadVideoChunked(token, mediaUrl, remote.size, mediaType, onProgress);
    }

    // Simple multipart upload for images (small — buffering is fine)
    const mediaRes = await fetch(mediaUrl);
    if (!mediaRes.ok) throw new Error(`Failed to fetch media for Twitter: ${mediaRes.status}`);
    const mediaBuffer = Buffer.from(await mediaRes.arrayBuffer());

    const uploadUrl = "https://upload.twitter.com/1.1/media/upload.json";
    const oauth = this.makeOAuth();
    const header = oauth.toHeader(oauth.authorize({ url: uploadUrl, method: "POST" }, token));

    const form = new FormData();
    form.append("media", new Blob([mediaBuffer], { type: mediaType }), "upload");
    form.append("media_category", "tweet_image");

    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: header.Authorization },
      body: form,
    });

    const text = await res.text();
    if (!text) throw new Error(`Twitter image upload HTTP ${res.status} (empty response)`);
    let data: any;
    try { data = JSON.parse(text); } catch {
      throw new Error(`Twitter image upload non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    if (!res.ok) throw new Error(`Twitter image upload failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
    return data.media_id_string ?? data.data?.id;
  }

  /**
   * Chunked upload flow required for all video files. STREAMING: each 5MB
   * APPEND segment is range-fetched from the media host just before its POST
   * (never the whole file at once). X rejects oversized videos at INIT via
   * total_bytes, so a too-big file fails fast without transferring anything.
   */
  private async uploadVideoChunked(
    token: { key: string; secret: string },
    mediaUrl: string,
    totalBytes: number,
    mediaType: string,
    onProgress?: (percent: number) => void | Promise<void>
  ): Promise<string> {
    const uploadUrl = "https://upload.twitter.com/1.1/media/upload.json";
    const oauth = this.makeOAuth();

    // --- INIT ---
    const initParams = {
      command: "INIT",
      total_bytes: totalBytes.toString(),
      media_type: mediaType,
      media_category: "tweet_video",
    };
    const initHeader = oauth.toHeader(
      oauth.authorize({ url: uploadUrl, method: "POST", data: initParams }, token)
    );
    const initRes = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: initHeader.Authorization, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(initParams).toString(),
    });
    const initText = await initRes.text();
    if (!initRes.ok) throw new Error(`Twitter video INIT failed (${initRes.status}): ${initText}`);
    const initData = JSON.parse(initText);
    const mediaId: string = initData.media_id_string;

    // --- APPEND (5 MB chunks, range-fetched one at a time) ---
    const chunkSize = 5 * 1024 * 1024;
    const ranges = computeByteRanges(totalBytes, chunkSize);
    for (let i = 0; i < ranges.length; i++) {
      const [start, end] = ranges[i]!;
      const chunk = await fetchByteRange(mediaUrl, start, end);
      const appendHeader = oauth.toHeader(
        oauth.authorize({ url: uploadUrl, method: "POST" }, token)
      );
      const form = new FormData();
      form.append("command", "APPEND");
      form.append("media_id", mediaId);
      form.append("segment_index", i.toString());
      form.append("media", new Blob([new Uint8Array(chunk)], { type: mediaType }), "chunk");
      const appendRes = await fetch(uploadUrl, {
        method: "POST",
        headers: { Authorization: appendHeader.Authorization },
        body: form,
      });
      if (!appendRes.ok) {
        const err = await appendRes.text();
        throw new Error(`Twitter video APPEND segment ${i} failed (${appendRes.status}): ${err}`);
      }
      // Progress per segment (10→90%): user-visible upload progress AND the
      // watchdog's active-upload signal (reportProgress touches the target's
      // updatedAt) — long X uploads must never be falsely reaped.
      await onProgress?.(10 + Math.round(((i + 1) / ranges.length) * 80));
    }

    // --- FINALIZE ---
    const finalizeParams = { command: "FINALIZE", media_id: mediaId };
    const finalizeHeader = oauth.toHeader(
      oauth.authorize({ url: uploadUrl, method: "POST", data: finalizeParams }, token)
    );
    const finalizeRes = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: finalizeHeader.Authorization, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(finalizeParams).toString(),
    });
    const finalizeText = await finalizeRes.text();
    if (!finalizeRes.ok) throw new Error(`Twitter video FINALIZE failed (${finalizeRes.status}): ${finalizeText}`);
    const finalizeData = JSON.parse(finalizeText);

    // --- STATUS poll (if processing required) ---
    if (finalizeData.processing_info) {
      await this.pollVideoStatus(
        token,
        mediaId,
        totalBytes,
        finalizeData.processing_info?.check_after_secs,
        onProgress
      );
    }

    return mediaId;
  }

  /**
   * Poll media/upload STATUS until video processing completes. Respects X's
   * `check_after_secs` pacing hint (clamped 3–30s) and scales the overall
   * deadline with the file size — large videos routinely take minutes to
   * process after a fully-successful upload, so a fixed 90s cap threw away
   * complete uploads.
   */
  private async pollVideoStatus(
    token: { key: string; secret: string },
    mediaId: string,
    totalBytes: number,
    initialCheckAfterSecs?: number,
    onProgress?: (percent: number) => void | Promise<void>
  ): Promise<void> {
    const uploadUrl = "https://upload.twitter.com/1.1/media/upload.json";
    const oauth = this.makeOAuth();
    const clampWait = (secs: number) => Math.min(30, Math.max(3, secs));

    // 60s base + 0.5s per MB, 15min ceiling — a 512MB near-cap video ≈ 5.3min.
    const startedAt = Date.now();
    const deadline =
      startedAt + Math.min(15 * 60_000, 60_000 + Math.ceil(totalBytes / (1024 * 1024)) * 500);
    let waitSecs = clampWait(initialCheckAfterSecs ?? 3);
    let ticks = 0;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, waitSecs * 1000));
      ticks++;

      // One transient STATUS hiccup must not abort an otherwise-healthy poll:
      // only the explicit "failed" state (or the deadline) is terminal.
      let data: any = null;
      try {
        const statusUrl = `${uploadUrl}?command=STATUS&media_id=${mediaId}`;
        const header = oauth.toHeader(oauth.authorize({ url: statusUrl, method: "GET" }, token));
        const res = await fetch(statusUrl, { headers: { Authorization: header.Authorization } });
        data = await res.json();
      } catch (err: any) {
        console.warn(`[Twitter] STATUS poll error (transient, continuing): ${err?.message}`);
      }

      if (data) {
        const info = data.processing_info;
        const state = info?.state;
        console.log(`[Twitter] Video processing state: ${state} (poll ${ticks})`);

        if (state === "succeeded") return;
        if (state === "failed") {
          throw new Error(`Twitter video processing failed: ${JSON.stringify(info)}`);
        }
        // Respect X's pacing hint for the next poll.
        waitSecs = clampWait(info?.check_after_secs ?? 3);
      }

      // Best-effort progress tick (90→99): keeps the target's updatedAt fresh
      // so the watchdog's active-upload skip applies during multi-minute
      // processing. APPEND caps at 90; PUBLISHED clears uploadProgress.
      try {
        await onProgress?.(Math.min(99, 90 + ticks));
      } catch {
        // progress reporting must never fail the poll
      }
    }

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    throw new Error(`Twitter video processing timed out after ${elapsed}s (media_id ${mediaId})`);
  }
}
