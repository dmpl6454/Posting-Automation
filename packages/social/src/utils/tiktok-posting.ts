/**
 * TikTok Content Posting API — the pure rules (2026-10-28).
 *
 * Everything here is dependency-free so the browser can deep-import it for the
 * Compose posting card (`@postautomation/social/src/utils/tiktok-posting`), and
 * the provider, the API and the worker all agree on ONE set of rules.
 *
 * Shape of a TikTok Direct Post:
 *   1. creator_info/query  → what THIS creator allows right now (privacy options,
 *      whether comments/duet/stitch are switched off, max video length). TikTok
 *      requires it before every post.
 *   2. video/init          → publish_id (+ upload_url for FILE_UPLOAD).
 *   3. PUT the chunks      → only for FILE_UPLOAD.
 *   4. status/fetch        → poll until PUBLISH_COMPLETE or FAILED.
 *
 * ⚠️ A post id is a 19-digit integer — larger than Number.MAX_SAFE_INTEGER — and
 * TikTok sends it as a JSON NUMBER. `JSON.parse` silently rounds it to a
 * different id. Read ids from the RAW body with `extractPublicPostIds`.
 */

/**
 * Where things live (cross-slice contract, 2026-10-28):
 *  - `Post.metadata.tiktokByChannel` — { [channelId]: TikTokPostSettings }, written ONLY
 *    by the server from post.create / post.update's `tiktok` input (a raw client copy
 *    is stripped). Per channel because each creator allows different options.
 *  - The publish worker hands the provider THIS target's settings as
 *    `payload.metadata.tiktok` (TIKTOK_SETTINGS_KEY), plus `channelUsername`
 *    and, when the media probe knows it, `videoDurationSec`.
 *  - `PostTarget.metadata.tiktokPublish` — the publish_id checkpoint (see
 *    TikTokPublishCheckpoint), written through onCheckpoint the moment init
 *    succeeds, so a retry checks THAT publish instead of posting again.
 */
export const TIKTOK_BY_CHANNEL_KEY = "tiktokByChannel" as const;
export const TIKTOK_SETTINGS_KEY = "tiktok" as const;
export const TIKTOK_CHECKPOINT_KEY = "tiktokPublish" as const;

export interface TikTokPublishCheckpoint {
  publishId: string;
  /** ISO time the init succeeded. */
  createdAt: string;
  source: "PULL_FROM_URL" | "FILE_UPLOAD";
  /**
   * Set by post.clearPublishAmbiguity ("It didn't publish") instead of deleting
   * the checkpoint. A retry still RESUMES this publish — PROCESSING waits,
   * COMPLETE is adopted — and only a definite "TikTok can't report on this
   * publish_id" answer is then read as permission to post again. Deleting the
   * checkpoint made Retry post a second copy of a video that was still
   * processing (TikTok has no delete API).
   */
  clearedAt?: string;
  /**
   * tiktokCaptionFingerprint of the caption sent at init. A publish TikTok
   * FAILED for a reason it says must not be retried (spam_risk_text, a
   * *_check_failed, …) is only posted again once the caption has changed.
   */
  captionHash?: string;
  /** The creator's @handle at init (fresh creator_info), so a resumed publish can still link the video. */
  username?: string;
}

export function readTikTokCheckpoint(metadata: unknown): TikTokPublishCheckpoint | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>)[TIKTOK_CHECKPOINT_KEY];
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.publishId !== "string" || !/^[\w~.-]{1,200}$/.test(c.publishId)) return null;
  if (typeof c.createdAt !== "string" || Number.isNaN(Date.parse(c.createdAt))) return null;
  if (c.source !== "PULL_FROM_URL" && c.source !== "FILE_UPLOAD") return null;
  const out: TikTokPublishCheckpoint = { publishId: c.publishId, createdAt: c.createdAt, source: c.source };
  // Optional fields: a malformed one is dropped, never trusted, and never voids the checkpoint.
  if (typeof c.clearedAt === "string" && !Number.isNaN(Date.parse(c.clearedAt))) out.clearedAt = c.clearedAt;
  if (typeof c.captionHash === "string" && /^[0-9a-f]{8,64}$/.test(c.captionHash)) out.captionHash = c.captionHash;
  if (typeof c.username === "string" && TIKTOK_USERNAME_RE.test(c.username)) out.username = c.username;
  return out;
}

/** Read one channel's settings out of `Post.metadata.tiktokByChannel`. */
export function readTikTokSettingsForChannel(postMetadata: unknown, channelId: string): TikTokPostSettings | null {
  if (!postMetadata || typeof postMetadata !== "object") return null;
  const byChannel = (postMetadata as Record<string, unknown>)[TIKTOK_BY_CHANNEL_KEY];
  if (!byChannel || typeof byChannel !== "object" || Array.isArray(byChannel)) return null;
  if (!Object.prototype.hasOwnProperty.call(byChannel, channelId)) return null;
  return readTikTokSettings({ [TIKTOK_SETTINGS_KEY]: (byChannel as Record<string, unknown>)[channelId] });
}

/**
 * Errors TikTok returns when the CREATOR cannot post right now (creator_info or
 * init). Pre-write and not retryable by us: the user has to wait or act in TikTok.
 */
export const TIKTOK_CANNOT_POST_CODES = [
  "spam_risk_too_many_posts",
  "spam_risk_user_banned_from_posting",
  "reached_active_user_cap",
  "spam_risk_too_many_pending_share",
  "spam_risk",
] as const;

/** Every privacy level TikTok defines; a creator's allowed subset comes from creator_info. */
export const TIKTOK_PRIVACY_LEVELS = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
] as const;
export type TikTokPrivacyLevel = (typeof TIKTOK_PRIVACY_LEVELS)[number];

export const TIKTOK_PRIVACY_LABELS: Record<TikTokPrivacyLevel, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};

export function isTikTokPrivacyLevel(v: unknown): v is TikTokPrivacyLevel {
  return typeof v === "string" && (TIKTOK_PRIVACY_LEVELS as readonly string[]).includes(v);
}

/** The caption ("title") limit, counted in UTF-16 code units — a JS string's `.length`. */
export const TIKTOK_TITLE_MAX = 2200;

/** Cut a caption to TikTok's limit without splitting a surrogate pair (an emoji). */
/**
 * True when a caption is over TikTok's title limit. It is REFUSED, never cut: a
 * cut caption is text the user never saw, and the cut usually lands on the
 * trailing #ad disclosure. Counted in UTF-16 units, like TikTok (String#length).
 */
export function tiktokCaptionTooLong(text: string | null | undefined): boolean {
  return (text ?? "").length > TIKTOK_TITLE_MAX;
}

export const TIKTOK_CAPTION_TOO_LONG_MESSAGE =
  "This TikTok caption is longer than TikTok's 2,200 characters. Shorten it, then publish again. Nothing was sent to TikTok.";

/**
 * A short, stable fingerprint of a caption (64-bit FNV-1a, hex). Change
 * detection only — NOT a security hash. Pure JS so the browser can import this
 * module.
 */
export function tiktokCaptionFingerprint(text: string | null | undefined): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const ch of text ?? "") {
    h ^= BigInt(ch.codePointAt(0)!);
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

/* ─────────────────────────── FILE_UPLOAD chunking ─────────────────────────── */

export const TIKTOK_MIN_CHUNK = 5 * 1024 * 1024;
export const TIKTOK_MAX_CHUNK = 64 * 1024 * 1024;
/** The final chunk may run over chunk_size, up to this. */
export const TIKTOK_MAX_FINAL_CHUNK = 128 * 1024 * 1024;
export const TIKTOK_MAX_CHUNKS = 1000;
/**
 * TikTok writes "4 GB". Read it as DECIMAL (4,000,000,000 bytes): a file between
 * 4.0e9 and 4 GiB would otherwise pass our checks and be refused by TikTok after
 * init, costing one of the creator's ~15 daily posts.
 */
export const TIKTOK_MAX_VIDEO_BYTES = 4_000_000_000;
/**
 * Our chunk size: one chunk is held in worker memory at a time, so smaller is
 * kinder to the box; 10 MiB keeps a 4 GiB file at ~410 PUTs (well under 1,000).
 */
export const TIKTOK_DEFAULT_CHUNK = 10 * 1024 * 1024;

export interface TikTokChunkPlan {
  videoSize: number;
  chunkSize: number;
  totalChunkCount: number;
  /** Inclusive byte ranges, in order; the last one absorbs the remainder. */
  ranges: Array<{ start: number; end: number }>;
}

/**
 * TikTok's chunk rules: a file under 5 MiB is ONE chunk whose size is the file
 * size; otherwise every chunk is chunk_size (5–64 MiB) except the last, which
 * takes the remainder and may be up to 128 MiB; total_chunk_count is
 * floor(video_size / chunk_size) and at most 1,000.
 */
export function planTikTokChunks(videoSize: number, preferredChunk = TIKTOK_DEFAULT_CHUNK): TikTokChunkPlan {
  if (!Number.isSafeInteger(videoSize) || videoSize <= 0) throw new Error("Video size must be a positive integer");
  if (videoSize > TIKTOK_MAX_VIDEO_BYTES) throw new Error("TikTok accepts videos up to 4 GB");
  if (videoSize < TIKTOK_MIN_CHUNK) {
    return { videoSize, chunkSize: videoSize, totalChunkCount: 1, ranges: [{ start: 0, end: videoSize - 1 }] };
  }
  // A file smaller than the preferred chunk (5–64 MiB) goes up as ONE chunk of
  // its own size — floor(size / chunk) would otherwise be 0 chunks.
  let chunkSize = Math.min(Math.max(preferredChunk, TIKTOK_MIN_CHUNK), TIKTOK_MAX_CHUNK, videoSize);
  while (Math.floor(videoSize / chunkSize) > TIKTOK_MAX_CHUNKS && chunkSize < TIKTOK_MAX_CHUNK) {
    chunkSize = Math.min(chunkSize * 2, TIKTOK_MAX_CHUNK);
  }
  const totalChunkCount = Math.floor(videoSize / chunkSize);
  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < totalChunkCount; i++) {
    const start = i * chunkSize;
    const end = i === totalChunkCount - 1 ? videoSize - 1 : start + chunkSize - 1;
    ranges.push({ start, end });
  }
  const last = ranges[ranges.length - 1]!;
  if (last.end - last.start + 1 > TIKTOK_MAX_FINAL_CHUNK) throw new Error("TikTok chunk plan exceeds the final-chunk limit");
  return { videoSize, chunkSize, totalChunkCount, ranges };
}

/** The Content-Range header TikTok expects on each chunk PUT. */
export function tiktokContentRange(range: { start: number; end: number }, total: number): string {
  return `bytes ${range.start}-${range.end}/${total}`;
}

/* ─────────────────────────────── creator_info ─────────────────────────────── */

export interface TikTokCreatorInfo {
  nickname: string;
  username: string;
  avatarUrl: string | null;
  privacyLevelOptions: TikTokPrivacyLevel[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  /** null when TikTok did not say. */
  maxVideoPostDurationSec: number | null;
}

/** Defensive read of creator_info/query's `data`. Unknown privacy values are dropped. */
export function parseCreatorInfo(data: unknown): TikTokCreatorInfo | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const options = Array.isArray(d.privacy_level_options) ? d.privacy_level_options.filter(isTikTokPrivacyLevel) : [];
  if (options.length === 0) return null;
  const max = Number(d.max_video_post_duration_sec);
  return {
    nickname: typeof d.creator_nickname === "string" ? d.creator_nickname : "",
    username: typeof d.creator_username === "string" ? d.creator_username : "",
    avatarUrl: typeof d.creator_avatar_url === "string" && /^https:\/\//.test(d.creator_avatar_url) ? d.creator_avatar_url : null,
    privacyLevelOptions: options,
    commentDisabled: d.comment_disabled === true,
    duetDisabled: d.duet_disabled === true,
    stitchDisabled: d.stitch_disabled === true,
    maxVideoPostDurationSec: Number.isFinite(max) && max > 0 ? max : null,
  };
}

/* ────────────────────────── per-post settings contract ────────────────────── */

/**
 * What the user chose on the TikTok posting card, stored server-side in
 * `Post.metadata.tiktok`. Interaction fields are POSITIVE ("allow") because that
 * is how TikTok's guidelines phrase the toggles; the API wants `disable_*`.
 */
export interface TikTokPostSettings {
  privacyLevel: TikTokPrivacyLevel;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  /** "Your brand" — promoting the creator's own business. */
  brandOrganic: boolean;
  /** "Branded content" — a paid partnership with a third party. */
  brandContent: boolean;
  /** AI-generated content label. */
  isAigc: boolean;
}

/**
 * Read the settings back from post metadata, DEFENSIVELY. Null when absent or
 * malformed — the provider then refuses to post rather than guessing a privacy
 * level (TikTok's guidelines forbid a default).
 */
export function readTikTokSettings(metadata: unknown): TikTokPostSettings | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[TIKTOK_SETTINGS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (!isTikTokPrivacyLevel(s.privacyLevel)) return null;
  const bool = (v: unknown) => v === true;
  return {
    privacyLevel: s.privacyLevel,
    allowComment: bool(s.allowComment),
    allowDuet: bool(s.allowDuet),
    allowStitch: bool(s.allowStitch),
    brandOrganic: bool(s.brandOrganic),
    brandContent: bool(s.brandContent),
    isAigc: bool(s.isAigc),
  };
}

/**
 * Check a post's settings against what the creator allows RIGHT NOW. Returns an
 * actionable message, or null when the post can go out. Used by the Compose card
 * (live creator_info) and by the provider just before init (fresh creator_info),
 * so a setting the creator changed after scheduling is caught before posting.
 */
export function validateTikTokSettings(
  settings: TikTokPostSettings,
  creator: TikTokCreatorInfo,
  opts: { videoDurationSec?: number | null } = {},
): string | null {
  if (!creator.privacyLevelOptions.includes(settings.privacyLevel)) {
    const allowed = creator.privacyLevelOptions.map((p) => TIKTOK_PRIVACY_LABELS[p]).join(", ");
    return `This TikTok account can't post with "${TIKTOK_PRIVACY_LABELS[settings.privacyLevel]}" visibility right now. Choose one of: ${allowed}.`;
  }
  if (settings.brandContent && settings.privacyLevel === "SELF_ONLY") {
    return "Branded content can't be private on TikTok. Choose another visibility, or turn off Branded content.";
  }
  const turnedOff: string[] = [];
  if (settings.allowComment && creator.commentDisabled) turnedOff.push("comments");
  if (settings.allowDuet && creator.duetDisabled) turnedOff.push("Duet");
  if (settings.allowStitch && creator.stitchDisabled) turnedOff.push("Stitch");
  if (turnedOff.length > 0) {
    return `This TikTok account has ${turnedOff.join(", ")} turned off in its TikTok settings, so they can't be allowed on this post.`;
  }
  const dur = opts.videoDurationSec;
  const max = creator.maxVideoPostDurationSec;
  if (dur != null && max != null && dur > max + TIKTOK_DURATION_TOLERANCE_SEC) {
    return `This video is ${formatTikTokDuration(dur)} long; this TikTok account can post videos up to ${formatTikTokDuration(max)}.`;
  }
  return null;
}

/**
 * A video exported at exactly the limit commonly probes a few hundredths of a
 * second over it (the audio track runs long). Same allowance as the server's
 * 10-minute check in packages/api/src/lib/media-constraints.ts.
 */
export const TIKTOK_DURATION_TOLERANCE_SEC = 0.5;

/** "45s" under a minute, "m:ss" above — rounded UP, so an over-limit video never prints as the limit. */
export function formatTikTokDuration(sec: number): string {
  const s = Math.ceil(sec - 1e-9);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The post_info flags TikTok expects, from the user's choices. */
export function tiktokInteractionFlags(settings: TikTokPostSettings): {
  disable_comment: boolean;
  disable_duet: boolean;
  disable_stitch: boolean;
} {
  return {
    disable_comment: !settings.allowComment,
    disable_duet: !settings.allowDuet,
    disable_stitch: !settings.allowStitch,
  };
}

/**
 * The consent line TikTok's guidelines require next to the Post button. It
 * changes when the post is marked as branded content.
 */
export function tiktokConsentText(settings: Pick<TikTokPostSettings, "brandContent">): string {
  // Exact strings from TikTok's Content Sharing Guidelines (the default one has
  // no full stop there; kept verbatim).
  return settings.brandContent
    ? "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation."
    : "By posting, you agree to TikTok's Music Usage Confirmation";
}

/* ─────────────────────────────── status/fetch ─────────────────────────────── */

export type TikTokPublishState =
  | { state: "processing"; status: string }
  | { state: "complete"; postIds: string[] }
  | { state: "inbox" }
  | { state: "failed"; failReason: string }
  | { state: "unknown"; status: string };

/**
 * Every id in `publicaly_available_post_id` (TikTok's spelling) as a STRING,
 * read from the raw JSON text so a 19-digit id is not rounded by JSON.parse.
 */
export function extractPublicPostIds(rawJson: string): string[] {
  const m = /"publicaly_available_post_id"\s*:\s*\[([^\]]*)\]/.exec(rawJson);
  if (!m) return [];
  return [...m[1]!.matchAll(/"?(\d{1,25})"?/g)].map((x) => x[1]!);
}

/** Classify a status/fetch response. Pass the RAW body so ids survive. */
export function classifyTikTokStatus(rawJson: string): TikTokPublishState {
  let data: Record<string, unknown> = {};
  try {
    data = ((JSON.parse(rawJson) as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
  } catch {
    return { state: "unknown", status: "unreadable" };
  }
  const status = typeof data.status === "string" ? data.status : "";
  switch (status) {
    case "PUBLISH_COMPLETE":
      return { state: "complete", postIds: extractPublicPostIds(rawJson) };
    case "SEND_TO_USER_INBOX":
      return { state: "inbox" };
    case "FAILED":
      return { state: "failed", failReason: typeof data.fail_reason === "string" ? data.fail_reason : "unknown" };
    case "PROCESSING_UPLOAD":
    case "PROCESSING_DOWNLOAD":
      return { state: "processing", status };
    default:
      return { state: "unknown", status: status || "missing" };
  }
}

/* ──────────────────────────────── links ──────────────────────────────────── */

const TIKTOK_USERNAME_RE = /^[A-Za-z0-9._]{1,64}$/;

/**
 * The public URL of a posted video, or the creator's profile when TikTok gave no
 * public id (a private post, or one still in moderation). `@me/video/…` is not a
 * real TikTok URL.
 */
export function tiktokPostUrl(username: string | null | undefined, postId: string | null | undefined): string | null {
  const user = username && TIKTOK_USERNAME_RE.test(username) ? username : null;
  if (user && postId && /^\d{1,25}$/.test(postId)) return `https://www.tiktok.com/@${user}/video/${postId}`;
  if (user) return `https://www.tiktok.com/@${user}`;
  return null;
}
