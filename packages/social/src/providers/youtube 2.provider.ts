import type { SocialPlatform } from "@postautomation/db";
import { execFileSync } from "child_process";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import crypto from "crypto";
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

export interface ShortVideoProbe {
  width: number;
  height: number;
  durationSec: number;
}

export const SHORT_MAX_DURATION_SEC = 180;

/** Append #Shorts to the description for Short uploads, without duplicating it. */
export function buildShortDescription(content: string, isShort: boolean): string {
  if (!isShort) return content;
  if (/#shorts\b/i.test(content)) return content;
  return `${content}\n#Shorts`;
}

/**
 * Throw a clear, actionable error if a video chosen as a Short cannot be
 * classified as one by YouTube (landscape, or longer than 3 minutes).
 */
export function assertShortDimensions(probe: ShortVideoProbe): void {
  if (probe.width > probe.height) {
    throw new Error(
      `This video is ${probe.width}x${probe.height} (landscape). YouTube only treats vertical or square videos as Shorts. ` +
        `Upload a 9:16 vertical video, or post it as a regular Video instead.`
    );
  }
  if (probe.durationSec > SHORT_MAX_DURATION_SEC) {
    const mins = Math.floor(probe.durationSec / 60);
    const secs = Math.round(probe.durationSec % 60);
    throw new Error(
      `This video is ${mins}m ${secs}s long. YouTube Shorts must be 3 minutes (180s) or shorter. ` +
        `Trim the video, or post it as a regular Video instead.`
    );
  }
}

async function probeVideo(buffer: Buffer, contentType: string): Promise<ShortVideoProbe> {
  const TMP_DIR = "/tmp/yt-probe";
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  const ext = contentType.includes("quicktime") ? "mov" : "mp4";
  const tmpPath = join(TMP_DIR, `${crypto.randomBytes(8).toString("hex")}.${ext}`);
  try {
    writeFileSync(tmpPath, buffer);
    const out = execFileSync(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height:format=duration",
        "-of", "json",
        tmpPath,
      ],
      { encoding: "utf8" }
    );
    const parsed = JSON.parse(out);
    const stream = parsed.streams?.[0] ?? {};
    const width = Number(stream.width) || 0;
    const height = Number(stream.height) || 0;
    const durationSec = Number(parsed.format?.duration) || 0;
    if (!width || !height) {
      throw new Error("Could not read video dimensions for Shorts validation.");
    }
    return { width, height, durationSec };
  } finally {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
  }
}

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
    if (payload.mediaUrls?.length) {
      // Route on media TYPE, not just presence. The video-upload path POSTs the
      // file to YouTube's resumable VIDEO endpoint — feeding it an image (e.g. an
      // autopilot-generated PNG) makes YouTube reject the upload. Gate explicitly
      // so we fail with a clear message instead of corrupting the upload.
      const firstType = payload.mediaTypes?.[0] ?? "";
      if (!firstType.startsWith("video/")) {
        throw new Error(
          `YouTube requires a video file to publish. Received media of type "${firstType || "unknown"}". ` +
            `Image-only posts cannot be published to YouTube — attach an MP4 video instead.`
        );
      }
      return this.uploadVideo(tokens, payload);
    }

    // No media — create a community post via YouTube Data API activities.insert
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
      // YouTube returns customUrl with a leading "@" (e.g. "@tabishmukaddam").
      // Strip it so the UI can safely prepend its own "@" without doubling.
      username: channel.snippet.customUrl?.replace(/^@+/, "") ?? undefined,
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
    const isShort = String(payload.metadata?.format ?? "").toUpperCase() === "SHORT";
    const description = buildShortDescription(payload.content, isShort);
    const tags = (payload.metadata?.tags as string[]) || [];
    const privacyStatus = (payload.metadata?.privacyStatus as string) || "public";
    const categoryId = (payload.metadata?.categoryId as string) || "22"; // 22 = People & Blogs
    const onProgress = payload.onProgress;

    // Download the video file (progress: 0→10%)
    await onProgress?.(5);
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) throw new Error(`Failed to download video from ${videoUrl}`);
    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
    const videoContentType = videoRes.headers.get("content-type") || "video/mp4";
    const totalBytes = videoBuffer.length;

    // For Shorts, validate the file actually qualifies BEFORE uploading, so we
    // never silently publish a landscape/long video that YouTube treats as a
    // normal video. (No API flag forces "Short"; classification is by the file.)
    if (isShort) {
      const probe = await probeVideo(videoBuffer, videoContentType);
      assertShortDimensions(probe);
    }
    await onProgress?.(10);

    // Step 1: Initiate resumable upload
    const metadata = {
      snippet: { title, description, tags, categoryId },
      status: { privacyStatus, selfDeclaredMadeForKids: false },
    };

    const uploadParams = new URLSearchParams({ uploadType: "resumable", part: "snippet,status" });

    const initRes = await fetch(
      `https://www.googleapis.com/upload/youtube/v3/videos?${uploadParams.toString()}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": totalBytes.toString(),
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

    // Step 2: Chunked upload — 4MB chunks with progress callbacks (10→95%)
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB per chunk (YouTube minimum is 256KB, recommend ≥1MB)
    let bytesSent = 0;
    let finalData: any = null;

    while (bytesSent < totalBytes) {
      const chunkEnd = Math.min(bytesSent + CHUNK_SIZE, totalBytes);
      const chunk = videoBuffer.slice(bytesSent, chunkEnd);
      const chunkSize = chunk.length;

      const chunkRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": videoContentType,
          "Content-Length": chunkSize.toString(),
          "Content-Range": `bytes ${bytesSent}-${chunkEnd - 1}/${totalBytes}`,
        },
        body: chunk,
      });

      bytesSent = chunkEnd;

      // 308 Resume Incomplete = chunk accepted, more to send
      // 200/201 = upload complete
      if (chunkRes.status === 308) {
        // Report progress: 10% base + up to 85% for upload phase
        const uploadPct = Math.round((bytesSent / totalBytes) * 85);
        await onProgress?.(10 + uploadPct);
        continue;
      }

      if (chunkRes.status === 200 || chunkRes.status === 201) {
        finalData = await chunkRes.json();
        break;
      }

      // Error on this chunk
      const errBody = await chunkRes.json().catch(() => ({ error: `HTTP ${chunkRes.status}` }));
      throw new Error(`YouTube video upload failed on chunk (bytes ${bytesSent}/${totalBytes}): ${JSON.stringify(errBody)}`);
    }

    if (!finalData) throw new Error("YouTube upload completed but returned no data");

    await onProgress?.(100);

    return {
      platformPostId: finalData.id,
      url: `https://www.youtube.com/watch?v=${finalData.id}`,
      metadata: finalData,
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
