import { Worker, type Job } from "bullmq";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "@postautomation/db";
import { getSocialProvider } from "@postautomation/social";
import { safeFetchPublicImage } from "@postautomation/ai";
import { QUEUE_NAMES, type AvatarCacheJobData, createRedisConnection } from "@postautomation/queue";

// ── S3 (identical config to media-process.worker.ts) ─────────────────────
const s3 = new S3Client({
  region: process.env.S3_REGION || process.env.AWS_REGION || "us-east-1",
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: !!process.env.S3_ENDPOINT, // Required for MinIO
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

const S3_BUCKET = process.env.S3_BUCKET || "postautomation-media";
const S3_BASE_URL = process.env.S3_PUBLIC_URL || process.env.S3_BASE_URL || `https://${S3_BUCKET}.s3.amazonaws.com`;

// Same Graph API version the facebook/instagram providers pin (v18.0).
const GRAPH_BASE = "https://graph.facebook.com/v18.0";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // ~2MB cap — avatars are tiny
const FETCH_TIMEOUT_MS = 8_000;

/**
 * Platforms where provider.getProfile(tokens) IS the channel identity (the
 * connected account == the profile the tokens belong to), so its `avatar` is
 * the fresh profile picture. FACEBOOK/INSTAGRAM are handled separately (the
 * channel is a Page / IG Business account, not the token's user), and LinkedIn
 * org pages (platformId `org-…`) are excluded below for the same reason.
 */
const PROFILE_PLATFORMS = new Set(["TWITTER", "YOUTUBE", "THREADS", "LINKEDIN", "BLUESKY", "MASTODON"]);

function extFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
  };
  return map[mimeType.toLowerCase()] || "png";
}

/** True when the URL already points at our own S3 base (i.e. a cached copy). */
function isCachedS3Url(url: string | null | undefined): boolean {
  return !!url && url.startsWith(`${S3_BASE_URL}/`);
}

type ChannelForAvatar = {
  id: string;
  platform: string;
  platformId: string;
  avatar: string | null;
  accessToken: string;
  refreshToken: string | null;
  organizationId: string;
  metadata: unknown;
};

/**
 * Resolve a FRESH profile-picture URL for the channel. Returns null (never
 * throws to the caller's happy path) when the platform can't provide one —
 * the caller then decides keep-vs-skip. All platform quirks live here.
 */
async function resolveFreshAvatarUrl(channel: ChannelForAvatar): Promise<string | null> {
  // Multi-tenant providers (Mastodon instance, Bluesky PDS) read the target host
  // from tokens.metadata — WITHOUT it getProfile hits the DEFAULT host, which
  // both fails and would transmit the bearer token to the wrong server. Thread
  // the stored connect-time metadata (Channel.metadata) through so the request
  // goes to the channel's own instance/service.
  const meta = (channel.metadata ?? undefined) as Record<string, unknown> | undefined;
  const tokens = {
    accessToken: channel.accessToken,
    refreshToken: channel.refreshToken ?? undefined,
    ...(meta ? { metadata: meta } : {}),
  };

  if (channel.platform === "INSTAGRAM") {
    const res = await fetch(
      `${GRAPH_BASE}/${channel.platformId}?fields=profile_picture_url&access_token=${encodeURIComponent(channel.accessToken)}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    const data: any = await res.json();
    if (!res.ok) {
      console.warn(`[avatar-cache] IG profile_picture_url fetch failed for ${channel.id}: ${JSON.stringify(data?.error?.message ?? data)}`);
      return null;
    }
    return data.profile_picture_url || null;
  }

  if (channel.platform === "FACEBOOK") {
    // redirect=false returns JSON { data: { url } } instead of 302ing to the CDN.
    const res = await fetch(
      `${GRAPH_BASE}/${channel.platformId}/picture?redirect=false&width=200&access_token=${encodeURIComponent(channel.accessToken)}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    const data: any = await res.json();
    if (!res.ok) {
      console.warn(`[avatar-cache] FB page picture fetch failed for ${channel.id}: ${JSON.stringify(data?.error?.message ?? data)}`);
      return null;
    }
    return data.data?.url || null;
  }

  if (PROFILE_PLATFORMS.has(channel.platform)) {
    // LinkedIn org-page channels are keyed `org-{id}` — getProfile would return
    // the PERSONAL profile's avatar, not the page's. Fall through to the stored
    // URL for those.
    if (!(channel.platform === "LINKEDIN" && channel.platformId.startsWith("org-"))) {
      const provider = getSocialProvider(channel.platform as any);
      const profile = await provider.getProfile(tokens);
      return profile.avatar || null;
    }
  }

  // Other platforms (Telegram/Discord/WordPress/…): no cheap profile-picture
  // endpoint — re-download the stored URL if it's a platform https URL we have
  // not already cached (a stable non-signed URL is still worth pinning to S3).
  if (channel.avatar && channel.avatar.startsWith("https://") && !isCachedS3Url(channel.avatar)) {
    return channel.avatar;
  }
  return null;
}

export function createAvatarCacheWorker() {
  const worker = new Worker<AvatarCacheJobData>(
    QUEUE_NAMES.AVATAR_CACHE,
    async (job: Job<AvatarCacheJobData>) => {
      const { channelId } = job.data;
      console.log(`[avatar-cache] Processing job ${job.id} for channel ${channelId}`);

      // 1. Load channel — full row (NOT select) so the @postautomation/db
      // encryption extension decrypts accessToken/refreshToken, exactly like
      // analytics-sync.worker.ts.
      const channel = await prisma.channel.findUnique({ where: { id: channelId } });
      if (!channel) {
        console.warn(`[avatar-cache] Channel ${channelId} not found — skipping`);
        return { skipped: "channel_not_found" };
      }

      const keepReason = isCachedS3Url(channel.avatar)
        ? "kept_existing_s3_avatar"
        : "no_fresh_url";

      // 2. Resolve a fresh platform profile-picture URL (best-effort).
      let freshUrl: string | null = null;
      try {
        freshUrl = await resolveFreshAvatarUrl(channel);
      } catch (err: any) {
        console.warn(`[avatar-cache] Fresh-URL resolution failed for ${channelId} (${channel.platform}): ${err?.message ?? err}`);
      }
      if (!freshUrl) {
        // NEVER null out the stored avatar on failure — keep whatever we have.
        console.log(`[avatar-cache] No fresh avatar URL for ${channelId} (${channel.platform}) — ${keepReason}`);
        return { skipped: keepReason };
      }

      // 3. Download bytes (SSRF-gated: blocks private/loopback/metadata hosts).
      let image: { base64: string; mimeType: string } | null = null;
      try {
        image = await safeFetchPublicImage(freshUrl, { maxBytes: MAX_AVATAR_BYTES, timeoutMs: FETCH_TIMEOUT_MS });
      } catch (err: any) {
        console.warn(`[avatar-cache] Download failed for ${channelId}: ${err?.message ?? err}`);
      }
      if (!image) {
        console.log(`[avatar-cache] Avatar download rejected/failed for ${channelId} (${channel.platform}) — ${keepReason}`);
        return { skipped: keepReason };
      }

      // 4. Upload to S3 under a deterministic key (daily re-cache overwrites in
      // place, so the stored URL stays stable). max-age=1d — the object mutates
      // on each re-cache, so a year-long cache would pin stale images.
      const ext = extFromMime(image.mimeType);
      const key = `avatars/${channel.organizationId}/${channel.id}.${ext}`;
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: key,
            Body: Buffer.from(image.base64, "base64"),
            ContentType: image.mimeType,
            CacheControl: "public, max-age=86400",
          })
        );
      } catch (err: any) {
        console.error(`[avatar-cache] S3 upload failed for ${channelId}: ${err?.message ?? err}`);
        return { skipped: "s3_upload_failed" };
      }

      // 5. Point Channel.avatar at the durable public URL. The S3 key is
      // deterministic (overwritten in place on each re-cache), so append a
      // version query param: it changes the stored string every run — forcing
      // React to swap the <img> src and the browser to treat it as a fresh
      // cache entry — so a manual "Refresh logos" is visible immediately instead
      // of being masked by the object's 24h max-age at a stable URL.
      const publicUrl = `${S3_BASE_URL}/${key}?v=${Date.now()}`;
      await prisma.channel.update({
        where: { id: channel.id },
        data: { avatar: publicUrl },
      });

      console.log(`[avatar-cache] Cached avatar for channel ${channelId} (${channel.platform}) → ${publicUrl}`);
      return { avatar: publicUrl };
    },
    {
      connection: createRedisConnection(),
      // Gentle on platform APIs (FB Graph quota is per-app) — mirrors the
      // analytics-sync worker's throttle.
      concurrency: 2,
      limiter: { max: 5, duration: 1000 },
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[avatar-cache] Job ${job?.id} failed:`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[avatar-cache] Job ${job.id} completed`);
  });

  return worker;
}
