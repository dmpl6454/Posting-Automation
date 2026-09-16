/**
 * "Meta-ready" video preparation — pure decisions (2026-09-16).
 *
 * Deliberately its OWN module with ZERO imports, like video-overlay-args.ts:
 * video-overlay.ts pulls @postautomation/ai (langchain/langsmith) and the AWS
 * SDK, which makes a unit test of a pure rule unrunnable. The rules below guard
 * real production incidents, so they live where they can always be tested.
 *
 * WHY THIS EXISTS. Measured on prod 2026-09-16: an Instagram video fan-out to
 * ~53 channels spent p50 240s / p90 659s per target BEYOND its stagger slot,
 * almost all of it queued behind the per-TARGET ffmpeg watermark encode (a FIFO
 * semaphore of 2). Every target re-encoded the SAME source only to burn its own
 * channel name into it, and each encode left a never-deleted
 * `videos/overlay_<random>.mp4` behind (28.7GB of them in MinIO).
 *
 * The owner has authorised dropping the per-channel watermark. Without it the
 * encode no longer depends on the channel, so ONE encode per source can serve
 * the whole fan-out and every retry — and when the source is already the
 * media-optimize rendition, no encode is needed at all.
 */

/**
 * Per-channel video watermark (channel logo / channel name burned into IG/FB
 * videos). OFF by default — owner decision 2026-09-16.
 *
 * ⚠️ FAIL-CLOSED (`=== "true"`). docker-compose.prod.yml uses an explicit
 * `environment:` allowlist, so an unplumbed key arrives as "" or not at all; a
 * `!== "false"` check would read that as ENABLED (the PR #166 incident class)
 * and silently bring back one encode per target.
 */
export function isVideoWatermarkEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.VIDEO_WATERMARK_ENABLED === "true";
}

/**
 * What to do with ONE video before it is handed to Instagram/Facebook.
 *
 * - `skip-too-big`   publish the original untouched (over the overlay size cap —
 *                    the multi-GB path that is already proven on prod).
 * - `watermark`      the legacy per-TARGET encode with the channel logo/name,
 *                    byte-identical to the pre-2026-09-16 behaviour.
 * - `skip-rendition` the media-optimize rendition is already H.264 + yuv420p +
 *                    AAC + +faststart + ≤8Mbps + long edge ≤1920 — exactly what
 *                    the normalize encode would produce — so re-encoding it is
 *                    pure CPU. IG/FB already publish renditions directly for
 *                    >250MB originals, so this path is proven on prod.
 * - `normalize`      one SHARED, cached encode per source (rate control,
 *                    yuv420p, +faststart, plus the story canvas / text overlay
 *                    when requested).
 */
export type MetaVideoPrepPlan = "watermark" | "normalize" | "skip-rendition" | "skip-too-big";

export function planMetaVideoPrep(o: {
  watermarkOn: boolean;
  hasOverlayText: boolean;
  publishesAsStory: boolean;
  isRendition: boolean;
  tooBig: boolean;
}): MetaVideoPrepPlan {
  // Size first: the cap exists because a multi-GB re-encode exhausts the
  // worker's disk/CPU, and that is true whatever else was requested.
  if (o.tooBig) return "skip-too-big";
  if (o.watermarkOn) return "watermark";
  // ⚠️ A STORY must never skip: the 9:16 canvas rides inside the encode, and a
  // rendition is not 9:16. Same for burned-in text — the rendition has none.
  if (o.isRendition && !o.hasOverlayText && !o.publishesAsStory) return "skip-rendition";
  return "normalize";
}

/**
 * Bump when the normalize ffmpeg argv/filter graph changes in a way that alters
 * the output. The version is part of the object key, so a bump makes every old
 * cached artifact unreachable instead of silently serving the old encode.
 */
export const META_READY_ARGS_VERSION = "v1";

/**
 * Deterministic S3 key for the shared normalize artifact.
 *
 * The output of the channel-less encode depends ONLY on these inputs, so every
 * target of a fan-out (and every retry, and a later post reusing the same
 * media) resolves to the same object — the discipline story-media.ts and
 * super-text.worker.ts already use.
 *
 * - Canonical JSON with a FIXED key order, and `null` for absent values, so
 *   `undefined` vs "" vs missing cannot produce two keys for one output.
 * - The hash is INJECTED so this module keeps zero imports.
 * - Keep the `.mp4` extension: instagram.provider.ts sniffs video by URL
 *   extension FIRST.
 */
export function metaReadyObjectKey(
  input: {
    sourceUrl: string;
    text?: string;
    textPosition?: string;
    textFontSize?: number;
    storyCanvas: boolean;
  },
  sha256hex: (s: string) => string
): string {
  const canonical = JSON.stringify({
    v: META_READY_ARGS_VERSION,
    sourceUrl: input.sourceUrl,
    text: input.text || null,
    textPosition: input.textPosition || null,
    textFontSize: input.textFontSize || null,
    storyCanvas: input.storyCanvas === true,
  });
  return `videos/metaready/${sha256hex(canonical).slice(0, 40)}.mp4`;
}

/**
 * The truncation guard (same 98% rule media-optimize and super-text use).
 *
 * ffmpeg exiting 0 does NOT prove the whole input was consumed. It matters MORE
 * here than on the old per-target path: a short artifact written to the shared
 * key would be CACHED and reused by every later target and every later post.
 */
export function outputDurationAcceptable(inputSec: number, outputSec: number): boolean {
  if (!Number.isFinite(inputSec) || !Number.isFinite(outputSec)) return false;
  if (inputSec <= 0) return false;
  return outputSec >= inputSec * 0.98;
}

/**
 * Where a finished normalize encode may be stored.
 *
 * - `cache`     input duration known and the output passed the 98% rule —
 *               safe to write to the shared deterministic key.
 * - `uncached`  the input duration could not be measured (e.g. a browser
 *               MediaRecorder WebM carries no container duration), so the
 *               output cannot be VERIFIED. Refusing it would regress such
 *               uploads — the pre-2026-09-16 pass transcoded them — so it is
 *               stored under a one-off key exactly as the old pass did, but it
 *               is never written where another target could reuse it.
 * - `reject`    the input duration is known and the output is short (or
 *               unmeasurable): treat it as truncated and throw. The caller's
 *               fail-open path publishes the source instead.
 */
/**
 * How old a stored normalize artifact may be and still be REUSED.
 *
 * ⚠️ Coupled to the MinIO lifecycle rule that expires `videos/metaready/` after
 * 7 days (added 2026-09-16 with this code; see CLAUDE.md). A hit hands Meta a
 * URL that Meta fetches minutes later (Facebook's file_url pull can take longer),
 * so an artifact near its expiry must never be handed out: the lifecycle
 * scanner could delete it between our HeadObject and Meta's download, failing
 * the publish. Past this age the artifact is re-encoded, and the PUT to the same
 * key resets its age. The 2-day margin is deliberate. Keep this WELL below the
 * lifecycle rule; raising the rule is always safe, shortening it is not.
 */
export const META_READY_REUSE_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * Is a HeadObject result a usable cache hit? Only a non-empty object with a
 * known, recent modification time counts; anything unverifiable is a miss
 * (a miss costs one encode, a bad hit costs a failed publish).
 */
export function isReusableMetaReadyArtifact(head: {
  contentLength: number | undefined;
  lastModified: Date | undefined;
  now: number;
}): boolean {
  if (!((head.contentLength ?? 0) > 0)) return false;
  const modified = head.lastModified?.getTime();
  if (typeof modified !== "number" || !Number.isFinite(modified)) return false;
  return head.now - modified < META_READY_REUSE_MAX_AGE_MS;
}

export type MetaReadyStorage = "cache" | "uncached" | "reject";

export function planMetaReadyStorage(inputSec: number, outputSec: number): MetaReadyStorage {
  if (!Number.isFinite(inputSec) || inputSec <= 0) return "uncached";
  return outputDurationAcceptable(inputSec, outputSec) ? "cache" : "reject";
}
