/**
 * Pure decision logic for the media-optimize pipeline (media-optimize.worker).
 *
 * WHY (2026-07-21, live-verified): users upload pro-camera masters — e.g. a
 * 1.75GB 4K/50fps 222Mbps H.264 file with PCM audio. Three things break at
 * once: browser playback stutters (222Mbps can't stream in realtime) and is
 * SILENT (browsers don't decode PCM-in-MP4 audio), and Instagram/Facebook
 * reject the URL-pull server-side (IG hard limits: MP4/MOV ≤1GB, AAC audio —
 * error 2207076, 6/6 attempts observed). The fix is ONE web-optimized
 * rendition (H.264+AAC, ≤1080p long-edge 1920, ~8Mbps, +faststart) stored
 * NEXT TO the original: previews/publish use it, YouTube keeps the master.
 */

export interface ProbeSummary {
  videoCodec?: string;
  audioCodec?: string; // undefined = no audio track
  width?: number;
  height?: number;
  durationSec?: number;
  bitrate?: number; // bits/sec, container-level
}

export interface OptimizeState {
  status: "pending" | "processing" | "done" | "skipped" | "failed";
  url?: string;
  key?: string;
  size?: number;
  reasons?: string[];
  probe?: ProbeSummary;
  enqueuedAt?: string;
  error?: string;
}

/** Instagram's hard cap for URL-pull video (reels/feed) is 1GB. */
export const IG_MAX_BYTES = 1024 * 1024 * 1024;
/** Optimize anything close enough to the IG cap that publish WILL fail. */
export const OPTIMIZE_SIZE_BYTES = 950 * 1024 * 1024;
/** Above this container bitrate browsers stutter on typical connections. */
export const OPTIMIZE_BITRATE_BPS = 12_000_000;
/** Platforms cap long edges around 1920 — larger only wastes bytes. */
export const OPTIMIZE_MAX_EDGE = 1920;
/** How long the publish gate waits for a pending optimization before failing. */
export const OPTIMIZE_WAIT_CEILING_MS = 45 * 60 * 1000;

/** Audio codecs every platform + browser accepts as-is. */
const SAFE_AUDIO = new Set(["aac", "mp3"]);
/** Video codecs IG/FB/browsers take without re-encode. */
const SAFE_VIDEO = new Set(["h264"]);

export function evaluateOptimization(
  probe: ProbeSummary,
  fileSizeBytes: number
): { needed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (probe.audioCodec && !SAFE_AUDIO.has(probe.audioCodec)) {
    reasons.push(`audio codec ${probe.audioCodec} (platforms/browsers need AAC)`);
  }
  if (probe.videoCodec && !SAFE_VIDEO.has(probe.videoCodec)) {
    reasons.push(`video codec ${probe.videoCodec} (platforms need H.264)`);
  }
  if (fileSizeBytes > OPTIMIZE_SIZE_BYTES) {
    reasons.push(`file is ${(fileSizeBytes / 1e9).toFixed(2)}GB (Instagram caps at 1GB)`);
  }
  if ((probe.bitrate ?? 0) > OPTIMIZE_BITRATE_BPS) {
    reasons.push(`bitrate ${Math.round((probe.bitrate ?? 0) / 1e6)}Mbps (streams poorly; platforms re-reject)`);
  }
  const longEdge = Math.max(probe.width ?? 0, probe.height ?? 0);
  if (longEdge > OPTIMIZE_MAX_EDGE) {
    reasons.push(`${probe.width}x${probe.height} exceeds platform maximums`);
  }
  return { needed: reasons.length > 0, reasons };
}

/**
 * ffmpeg argv for the web rendition. ARGV ARRAY ONLY — never a shell string
 * (repo invariant since the 503/504 execSync incident). Long edge capped at
 * 1920 preserving aspect (portrait AND landscape), even dimensions forced,
 * H.264 veryfast CRF23 capped ~8Mbps, AAC 128k stereo, +faststart so the
 * moov atom leads and browsers can stream instantly.
 */
export function buildTranscodeArgs(inputUrl: string, outPath: string): string[] {
  return [
    "-y",
    "-i", inputUrl,
    "-vf", "scale=w=1920:h=1920:force_original_aspect_ratio=decrease:force_divisible_by=2",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-maxrate", "8M",
    "-bufsize", "16M",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ac", "2",
    "-movflags", "+faststart",
    "-threads", "3",
    outPath,
  ];
}

/** Platforms whose publishes may substitute the optimized rendition. */
const OPTIMIZED_PLATFORMS = new Set(["INSTAGRAM", "FACEBOOK", "TWITTER"]);

/**
 * Per-platform hard caps for publishing the ORIGINAL file. IG/FB URL-pull
 * rejects >1GB (2207076); X chunked upload INIT 400s above 512MB
 * (maxFileSizeBytes: 536870912 — live-seen 2026-07-21). Above the cap the
 * rendition is mandatory.
 */
const PLATFORM_ORIGINAL_CAPS: Record<string, number> = {
  INSTAGRAM: OPTIMIZE_SIZE_BYTES,
  FACEBOOK: OPTIMIZE_SIZE_BYTES,
  TWITTER: 512 * 1024 * 1024,
};

const PLATFORM_LABELS: Record<string, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  TWITTER: "X (Twitter)",
};

/**
 * Pick the URL the publish worker should hand a platform for one media row.
 * IG/FB video → optimized rendition when available; everything else — and
 * every other platform (YouTube deliberately gets the full-quality master) —
 * keeps the original URL.
 */
export function choosePublishUrl(
  platform: string,
  media: { url: string; fileType: string; fileSize?: number; metadata?: unknown }
): string {
  if (!OPTIMIZED_PLATFORMS.has(platform)) return media.url;
  if (!media.fileType.startsWith("video/")) return media.url;
  const opt = (media.metadata as { optimize?: OptimizeState } | null)?.optimize;
  const rendition = opt?.status === "done" && opt.url ? opt.url : null;
  if (!rendition) return media.url;
  // Instagram caps served video at ~1080 wide and transcodes EVERY upload —
  // the 1080x1920 rendition IS Instagram's own maximum, so nothing real is
  // lost. Facebook supports 4K and large URL-pulls, so it keeps the
  // FULL-RESOLUTION original (owner constraint 2026-07-21: never downgrade
  // resolution when the destination can take it) unless the original is
  // genuinely unpublishable: unsupported codec, or over the safe size cap.
  if (platform === "INSTAGRAM") return rendition;
  // FACEBOOK (4K-capable) and TWITTER keep the FULL-RESOLUTION original
  // (owner constraint: never downgrade when the destination can take it)
  // unless it's genuinely unpublishable there: unsupported codec, or over
  // that platform's hard cap.
  const probe = opt?.probe;
  const badCodec =
    (probe?.audioCodec && !SAFE_AUDIO.has(probe.audioCodec)) ||
    (probe?.videoCodec && !SAFE_VIDEO.has(probe.videoCodec));
  const tooBig = (media.fileSize ?? 0) > (PLATFORM_ORIGINAL_CAPS[platform] ?? Infinity);
  return badCodec || tooBig ? rendition : media.url;
}

export type OptimizeGateAction =
  | { action: "proceed" }
  | { action: "wait"; mediaId: string }
  | { action: "fail"; message: string };

/**
 * Publish-time gate for IG/FB video. Only files OVER the IG cap are gated —
 * publishing them raw is guaranteed to burn minutes and fail with an opaque
 * platform code, so we wait for (or trigger) the rendition instead. Smaller
 * files publish immediately exactly as before (zero regression), just with
 * the rendition preferred when it already exists.
 */
export function planOptimizeGate(params: {
  platform: string;
  media: Array<{ id: string; url: string; fileType: string; fileSize: number; metadata?: unknown }>;
  now: number;
}): OptimizeGateAction {
  const { platform, media, now } = params;
  const cap = PLATFORM_ORIGINAL_CAPS[platform];
  if (!OPTIMIZED_PLATFORMS.has(platform) || !cap) return { action: "proceed" };
  for (const m of media) {
    if (!m.fileType.startsWith("video/")) continue;
    if (m.fileSize <= cap) continue; // small enough — original is publishable
    const opt = (m.metadata as { optimize?: OptimizeState } | null)?.optimize;
    if (opt?.status === "done" && opt.url) continue; // rendition ready
    if (opt?.status === "failed") {
      return {
        action: "fail",
        message:
          `Video could not be optimized for ${PLATFORM_LABELS[platform] ?? platform} ` +
          `(${opt.reasons?.join("; ") || opt.error || "unknown reason"}). ` +
          `Export it as MP4 (H.264 + AAC audio, under 1GB) and re-upload.`,
      };
    }
    const enqueuedAt = opt?.enqueuedAt ? Date.parse(opt.enqueuedAt) : undefined;
    if (enqueuedAt && now - enqueuedAt > OPTIMIZE_WAIT_CEILING_MS) {
      return {
        action: "fail",
        message:
          "Video optimization did not finish in time. " +
          "Export the file as MP4 (H.264 + AAC audio, under 1GB) and re-upload, or retry later.",
      };
    }
    return { action: "wait", mediaId: m.id }; // pending/processing/missing → (re)enqueue + defer
  }
  return { action: "proceed" };
}
