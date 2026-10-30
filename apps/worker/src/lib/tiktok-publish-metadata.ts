/**
 * What the publish worker adds to a TIKTOK target's provider metadata
 * (2026-10-28). Pure, so the rules are unit-testable without the worker.
 *
 * The contract lives in packages/social/src/utils/tiktok-posting.ts:
 *  - `Post.metadata.tiktokByChannel` holds every channel's choices; the provider
 *    gets ONLY this target's block, as `metadata.tiktok`. When this channel has
 *    no valid block the key is ABSENT, and the provider refuses to post rather
 *    than guess a privacy level (TikTok's guidelines forbid a default).
 *  - `channelUsername` (the creator's @handle) builds the public post URL.
 *  - `videoDurationSec`, when the media probe knows it, is checked against the
 *    creator's `max_video_post_duration_sec` before anything is sent.
 *
 * ⚠️ Never call this for another platform: every other provider's payload must
 * stay byte-identical to what it was before TikTok posting existed.
 */
import {
  TIKTOK_BY_CHANNEL_KEY,
  TIKTOK_CHECKPOINT_KEY,
  TIKTOK_SETTINGS_KEY,
  readTikTokSettingsForChannel,
} from "@postautomation/social/src/utils/tiktok-posting";

/**
 * Keys a TIKTOK target never inherits from the post/target metadata spread —
 * only the worker supplies them (tiktokProviderMetadata, spread after this).
 */
export const TIKTOK_INHERITED_KEYS_TO_DROP = [
  TIKTOK_SETTINGS_KEY,
  TIKTOK_BY_CHANNEL_KEY,
  "channelUsername",
  "videoDurationSec",
] as const;

export interface TikTokMediaInput {
  fileType: string;
  /** Media.duration — whole seconds, written from the same probe. */
  duration?: number | null;
  metadata?: unknown;
}

/**
 * The attached video's length in seconds: the media-optimize probe's
 * `metadata.optimize.probe.durationSec` first (exact), then the `Media.duration`
 * column (rounded, written from the same probe). Null when neither is known —
 * the probe may still be pending, and the provider then skips the length check.
 */
export function videoDurationFromMedia(media: TikTokMediaInput[]): number | null {
  const v = media.find((m) => typeof m.fileType === "string" && m.fileType.startsWith("video/"));
  if (!v) return null;
  const probed = Number(
    ((v.metadata as { optimize?: { probe?: { durationSec?: unknown } } } | null | undefined)?.optimize?.probe
      ?.durationSec) ?? NaN
  );
  if (Number.isFinite(probed) && probed > 0) return probed;
  const column = Number(v.duration ?? NaN);
  if (Number.isFinite(column) && column > 0) return column;
  return null;
}

/** The keys to spread into a TIKTOK target's provider metadata (absent keys omitted). */
export function tiktokProviderMetadata(params: {
  postMetadata: unknown;
  channelId: string;
  channelUsername: string | null | undefined;
  media: TikTokMediaInput[];
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const settings = readTikTokSettingsForChannel(params.postMetadata, params.channelId);
  if (settings) out[TIKTOK_SETTINGS_KEY] = settings;
  if (typeof params.channelUsername === "string" && params.channelUsername.length > 0) {
    out.channelUsername = params.channelUsername;
  }
  const duration = videoDurationFromMedia(params.media);
  if (duration != null) out.videoDurationSec = duration;
  return out;
}

/**
 * The post + target metadata spread for a TIKTOK target, minus the keys only the
 * worker may set: a raw `tiktok` copy (from a client, or a legacy post) must
 * never stand in for this channel's own choice, and the other channels' blocks
 * are not this provider's business.
 *
 * ⚠️ The publish checkpoint (`tiktokPublish`) comes from the TARGET only. Post
 * metadata is client-writable at create (`.passthrough()`), and a checkpoint
 * there was inherited by every TikTok target without one of its own: the
 * provider RESUMES a checkpoint before any other check, so a forged publish_id
 * marked the post PUBLISHED with an earlier video, and the new one was never
 * sent. The real checkpoint is written only through onCheckpoint, onto the
 * target row.
 */
export function tiktokInheritedMetadata(postMetadata: unknown, targetMetadata: unknown): Record<string, unknown> {
  const post = isPlainObject(postMetadata) ? { ...postMetadata } : {};
  delete post[TIKTOK_CHECKPOINT_KEY];
  const out: Record<string, unknown> = { ...post, ...(isPlainObject(targetMetadata) ? targetMetadata : {}) };
  for (const k of TIKTOK_INHERITED_KEYS_TO_DROP) delete out[k];
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
