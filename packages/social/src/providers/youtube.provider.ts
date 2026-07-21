import type { SocialPlatform } from "@postautomation/db";
import { execFileSync, execFile } from "child_process";
import { promisify } from "util";
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const execFileAsync = promisify(execFile);
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
import { fetchT } from "../utils/fetch-timeout";
import { headRemoteMedia, fetchByteRange } from "../utils/ranged-media";

/**
 * Files at or below this stay on the classic buffered path (download once,
 * probe from the buffer, upload from buffer slices) — zero behavior change.
 * Larger files STREAM: each resumable chunk is fetched via an HTTP Range
 * request just before upload, so worker memory stays O(chunk) — a 4GB video
 * no longer needs 4GB of RAM.
 */
export const YT_STREAM_THRESHOLD_BYTES = 64 * 1024 * 1024;

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

function parseProbeOutput(out: string): ShortVideoProbe {
  const parsed = JSON.parse(out);
  const stream = parsed.streams?.[0] ?? {};
  const width = Number(stream.width) || 0;
  const height = Number(stream.height) || 0;
  const durationSec = Number(parsed.format?.duration) || 0;
  if (!width || !height) {
    throw new Error("Could not read video dimensions for Shorts validation.");
  }
  return { width, height, durationSec };
}

const FFPROBE_ARGS = [
  "-v", "error",
  "-select_streams", "v:0",
  "-show_entries", "stream=width,height:format=duration",
  "-of", "json",
];

async function probeVideo(buffer: Buffer, contentType: string): Promise<ShortVideoProbe> {
  const TMP_DIR = "/tmp/yt-probe";
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
  const ext = contentType.includes("quicktime") ? "mov" : "mp4";
  const tmpPath = join(TMP_DIR, `${crypto.randomBytes(8).toString("hex")}.${ext}`);
  try {
    writeFileSync(tmpPath, buffer);
    const out = execFileSync("ffprobe", [...FFPROBE_ARGS, tmpPath], { encoding: "utf8" });
    return parseProbeOutput(out);
  } finally {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
  }
}

/**
 * Probe a video by URL without downloading it (Phase 4 large-Shorts path).
 * ffprobe range-seeks over HTTP and reads only the metadata atoms, not the
 * whole file. The URL is our own S3/MinIO media URL (worker-controlled), and
 * execFile passes it as a discrete argv element — no shell interpolation.
 *
 * ASYNC + hard timeout (review finding): unlike the local-tmp-file probe
 * above, this call is network-bound — a stalled connection or a
 * non-faststart MP4 (moov atom at the tail forcing long seeks) must never
 * block the worker's event loop or hang the job.
 */
async function probeVideoUrl(url: string): Promise<ShortVideoProbe> {
  const { stdout } = await execFileAsync("ffprobe", [...FFPROBE_ARGS, url], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseProbeOutput(stdout);
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
    const res = await fetchT("https://oauth2.googleapis.com/token", {
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
    const res = await fetchT("https://oauth2.googleapis.com/token", {
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
    const res = await fetchT(
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

    // Probe size/type WITHOUT downloading (progress: 0→10%). Files at or
    // below YT_STREAM_THRESHOLD_BYTES keep the classic buffered path; larger
    // files stream chunk-by-chunk via Range requests (memory stays O(chunk)).
    await onProgress?.(5);
    const remote = await headRemoteMedia(videoUrl);
    const totalBytes = remote.size;
    const videoContentType = remote.contentType.startsWith("video/") ? remote.contentType : "video/mp4";
    const streamLarge = totalBytes > YT_STREAM_THRESHOLD_BYTES;

    let videoBuffer: Buffer | null = null;
    if (!streamLarge) {
      const videoRes = await fetch(videoUrl);
      if (!videoRes.ok) throw new Error(`Failed to download video from ${videoUrl}`);
      videoBuffer = Buffer.from(await videoRes.arrayBuffer());
    }

    // For Shorts, validate the file actually qualifies BEFORE uploading, so we
    // never silently publish a landscape/long video that YouTube treats as a
    // normal video. (No API flag forces "Short"; classification is by the file.)
    if (isShort) {
      const probe = videoBuffer
        ? await probeVideo(videoBuffer, videoContentType)
        : await probeVideoUrl(videoUrl); // large Short: ffprobe range-seeks the URL
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

    // Step 2: Chunked upload with progress callbacks (10→95%). Chunk sizes
    // must be multiples of 256KB (YouTube requirement, except the last chunk).
    // Streaming mode uses bigger chunks to cut roundtrips; each chunk is
    // range-fetched just before its PUT and garbage-collected right after.
    const CHUNK_SIZE = streamLarge ? 16 * 1024 * 1024 : 4 * 1024 * 1024;
    let bytesSent = 0;
    let finalData: any = null;

    // Streamed (>64MB) uploads get a bounded per-chunk retry with
    // resume-at-offset via Google's resumable protocol — one transient blip
    // at 95% of a 4GB upload must not discard 3.8GB of accepted bytes. The
    // ≤64MB buffered path keeps exactly one attempt per chunk (byte-identical
    // legacy behavior: any chunk failure throws immediately).
    const maxChunkAttempts = streamLarge ? 4 : 1;
    const RETRY_BACKOFF_MS = [2_000, 5_000, 15_000];
    let chunkAttempt = 0;

    const isTransientChunkError = (e: any): boolean => {
      const msg = String(e?.message ?? e ?? "");
      return (
        msg === "fetch failed" ||
        /ETIMEDOUT|ECONNRESET|EPIPE/i.test(msg) ||
        /Ranged fetch failed \(HTTP 5\d\d\)/.test(msg)
      );
    };

    // Shared 2xx parse (chunk PUT and offset query both use it).
    const parseFinal = async (res: Response): Promise<any> => {
      try {
        return await res.json();
      } catch {
        // Empty/truncated 2xx body — try to recover the video id from the
        // Location header (?v=<id>) before giving up with a clear error.
        const loc = res.headers.get("location") || "";
        const vidMatch = loc.match(/[?&]v=([^&]+)/);
        if (vidMatch?.[1]) return { id: vidMatch[1] };
        throw new Error("YouTube upload completed but returned no parseable body");
      }
    };

    // Resumable-protocol offset query: an empty PUT with
    // "Content-Range: bytes */<total>" returns 308 + a Range header holding
    // the bytes Google already accepted (resume there), or 200/201 when the
    // upload actually completed server-side (closes the final-chunk
    // double-publish window).
    const backoffAndResync = async (attempt: number): Promise<void> => {
      await new Promise((r) =>
        setTimeout(r, RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)])
      );
      try {
        const statusRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Range": `bytes */${totalBytes}`, "Content-Length": "0" },
        });
        if (statusRes.status === 308) {
          // Range: bytes=0-N → next byte is N+1. No Range header = nothing
          // accepted yet → restart from 0. Resume from Google's offset
          // EXACTLY (a 256KB multiple, valid as a chunk start) — never
          // realign to CHUNK_SIZE boundaries (skipping ahead corrupts).
          const m = statusRes.headers.get("range")?.match(/bytes=0-(\d+)/);
          bytesSent = m?.[1] ? parseInt(m[1], 10) + 1 : 0;
          return;
        }
        if (statusRes.status === 200 || statusRes.status === 201) {
          finalData = await parseFinal(statusRes);
          return;
        }
        // Unexpected status — resend the current chunk as-is next attempt.
      } catch {
        // Offset query itself failed — counts as this attempt's backoff cost.
      }
    };

    while (bytesSent < totalBytes && !finalData) {
      const chunkEnd = Math.min(bytesSent + CHUNK_SIZE, totalBytes);

      let chunkRes: Response;
      try {
        const chunk = videoBuffer
          ? videoBuffer.slice(bytesSent, chunkEnd)
          : await fetchByteRange(videoUrl, bytesSent, chunkEnd - 1);

        chunkRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": videoContentType,
            "Content-Length": chunk.length.toString(),
            "Content-Range": `bytes ${bytesSent}-${chunkEnd - 1}/${totalBytes}`,
          },
          body: new Uint8Array(chunk),
        });
      } catch (err) {
        // Thrown network/ranged-fetch error on this chunk. Non-transient
        // errors (incl. the fail-closed "Media host ignored Range") and the
        // buffered path throw immediately — classifyError upstream unchanged.
        if (chunkAttempt >= maxChunkAttempts - 1 || !isTransientChunkError(err)) throw err;
        chunkAttempt++;
        console.warn(
          `[YouTube] transient chunk error at bytes ${bytesSent} (retry ${chunkAttempt}/${maxChunkAttempts - 1}): ${(err as Error)?.message}`
        );
        await backoffAndResync(chunkAttempt);
        continue;
      }

      // 308 Resume Incomplete = chunk accepted, more to send
      // 200/201 = upload complete
      // The cursor advances ONLY on an accepted chunk — a failed attempt
      // resends from the same offset (or the offset Google reports).
      if (chunkRes.status === 308) {
        bytesSent = chunkEnd;
        chunkAttempt = 0;
        // Report progress: 10% base + up to 85% for upload phase
        const uploadPct = Math.round((bytesSent / totalBytes) * 85);
        await onProgress?.(10 + uploadPct);
        continue;
      }

      if (chunkRes.status === 200 || chunkRes.status === 201) {
        finalData = await parseFinal(chunkRes);
        break;
      }

      // Retryable HTTP status (5xx / 429) — streamed uploads only
      // (maxChunkAttempts is 1 on the buffered path, so this never fires there).
      if ((chunkRes.status >= 500 || chunkRes.status === 429) && chunkAttempt < maxChunkAttempts - 1) {
        chunkAttempt++;
        console.warn(
          `[YouTube] chunk PUT HTTP ${chunkRes.status} at bytes ${bytesSent} — retry ${chunkAttempt}/${maxChunkAttempts - 1}`
        );
        await backoffAndResync(chunkAttempt);
        continue;
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
