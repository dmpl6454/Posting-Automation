import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, createWriteStream, createReadStream, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join } from "path";
import crypto from "crypto";
import { createSemaphore } from "@postautomation/ai";
// Pure argv builder lives in its own dependency-free module so it stays
// unit-testable without dragging langchain through this file. Re-exported
// for existing importers.
import { buildOverlayFfmpegArgs } from "./video-overlay-args";
import { buildStoryCanvasFilter } from "./story-render-args";
import { metaReadyObjectKey, planMetaReadyStorage, isReusableMetaReadyArtifact } from "./meta-video-prep";
export { buildOverlayFfmpegArgs } from "./video-overlay-args";

// Async ffmpeg (stability guard, 2026-07-18): the sync encode blocked the whole
// worker event loop (every queue) for up to 180s. Same argv-array/no-shell
// pattern, promisified (proven in packages/ai/src/tools/reel-generator.ts).
const execFileAsync = promisify(execFile);

const TMP_DIR = "/tmp/video-overlay";

// Bound concurrent ffmpeg overlay runs. Each run costs a full re-encode (CPU)
// plus up to ~2× the video size in /tmp scratch on the 25GB disk MinIO shares
// — at PUBLISH_CONCURRENCY=10, unbounded overlays meant up to 10 simultaneous
// re-encodes. FIFO semaphore INSIDE processVideoOverlay so every caller is
// covered and the nothing-to-do early-return never consumes a slot.
// ⚠️ Coupling: raising PUBLISH_CONCURRENCY well past 10 without raising
// VIDEO_OVERLAY_CONCURRENCY can queue a job here long enough for the
// watchdog's 30-min idle-target reap — keep the ratio sane.
const overlaySemaphore = createSemaphore(
  Math.max(1, parseInt(process.env.VIDEO_OVERLAY_CONCURRENCY || "", 10) || 2)
);

/**
 * Kill switch for ALL publish-time video re-encoding on IG/FB. With it off,
 * IG/FB pull the stored video (or the optimized rendition) straight from S3.
 *
 * It governs more than branding: the story 9:16 canvas and the Meta-ready
 * normalization (rate control, yuv420p, +faststart) ride inside the same pass,
 * so VIDEO_OVERLAY_ENABLED=false disables those too — a story video then
 * publishes unpadded (the worker logs it).
 *
 * The per-channel watermark itself (channel logo / name) is separately
 * governed by VIDEO_WATERMARK_ENABLED (meta-video-prep.ts), OFF by default
 * since 2026-09-16.
 *
 * Historical cost note: the saving is CPU, not bandwidth — a rate-controlled
 * encode is ~the size of the optimizer's rendition. The per-target encode is
 * what pegged the 4-core box on 2026-08-07 (39 channels ⇒ 39 encodes).
 */
export function isVideoOverlayEnabled(): boolean {
  return process.env.VIDEO_OVERLAY_ENABLED !== "false";
}

interface VideoOverlayOptions {
  text?: string;              // headline/supertext to burn on video
  textPosition?: "top" | "center" | "bottom";
  textFontSize?: number;
  logoUrl?: string | null;    // channel logo URL to watermark
  channelName?: string;       // fallback watermark text if no logo
  logoPosition?: "top_left" | "top_right" | "bottom_left" | "bottom_right";
  logoSize?: number;          // logo width in pixels (default 120)
  /**
   * Fit the video onto the 1080x1920 story canvas, padding with a blurred copy
   * of itself (2026-09-16).
   *
   * Spliced into the FRONT of this pass's existing filter graph on purpose: a
   * story video is already re-encoded here for the watermark, and a SECOND
   * ffmpeg pass per target is the 2026-08-07 incident that collapsed a
   * 39-channel publish. Absent this flag the graph is byte-identical.
   */
  storyCanvas?: boolean;
  /**
   * Re-encode even when nothing is drawn (2026-09-16), so the output still gets
   * this pass's Meta-ready argv: rate control, yuv420p and +faststart (moov
   * first — Meta's reel spec requires it). Used by the watermark-free path,
   * where an original upload may be yuv444p or moov-at-end.
   */
  normalize?: boolean;
  /**
   * Defense-in-depth size cap: if the remote video's Content-Length exceeds
   * this, skip the overlay and return the ORIGINAL url (same degraded path as
   * the caller's fileSize gate). Covers forged/NULL/stale DB sizes. Fail-open
   * when the header is absent (non-S3 hosts) to avoid regressing behavior.
   */
  maxBytes?: number;
}

type LogoPosition = NonNullable<VideoOverlayOptions["logoPosition"]>;
type TextPosition = NonNullable<VideoOverlayOptions["textPosition"]>;

/**
 * Add logo watermark and/or text overlay to a video using FFmpeg.
 * Downloads video, processes it, uploads to S3, returns new URL.
 *
 * Two storage shapes (2026-09-16):
 * - PER-CHANNEL input (logo or channel name — the watermark): the output is
 *   unique to one target, so it is encoded per target under a one-off key,
 *   exactly as before.
 * - NO per-channel input: the output depends only on the source and the
 *   requested text/canvas, so ONE encode is written to a deterministic key and
 *   reused by every target of the fan-out, every retry and every later post.
 *   Measured 2026-09-16: a ~53-channel IG video fan-out waited p50 240s per
 *   target behind per-target encodes of the same file.
 */
export async function processVideoOverlay(
  videoUrl: string,
  options: VideoOverlayOptions = {}
): Promise<string> {
  const {
    text,
    textPosition = "bottom",
    textFontSize = 42,
    logoUrl,
    channelName,
    logoPosition = "bottom_right",
    logoSize = 120,
    maxBytes,
    storyCanvas = false,
    normalize = false,
  } = options;

  if (!text && !logoUrl && !channelName && !storyCanvas && !normalize) return videoUrl; // nothing to do
  // Operator kill switch — checked BEFORE the semaphore so a disabled overlay
  // never queues behind an in-flight encode.
  if (!isVideoOverlayEnabled()) {
    console.log("[VideoOverlay] Disabled via VIDEO_OVERLAY_ENABLED=false — posting original");
    return videoUrl;
  }

  if (!logoUrl && !channelName) {
    return runSharedMetaReady(videoUrl, { text, textPosition, textFontSize, storyCanvas, maxBytes });
  }

  return runLegacyOverlay(videoUrl, {
    text,
    textPosition,
    textFontSize,
    logoUrl,
    channelName,
    logoPosition,
    logoSize,
    maxBytes,
    storyCanvas,
    normalize,
  });
}

// ── Shared S3 plumbing ───────────────────────────────────────────────────────

type S3Target = {
  client: import("@aws-sdk/client-s3").S3Client;
  bucket: string;
  publicUrl: (key: string) => string;
};

async function s3Target(): Promise<S3Target> {
  const { S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || "",
    },
  });
  const bucket = process.env.S3_BUCKET || "postautomation-media";
  const publicUrl = (key: string): string =>
    process.env.S3_PUBLIC_URL
      ? `${process.env.S3_PUBLIC_URL}/${key}`
      : `${process.env.S3_ENDPOINT || "https://s3.amazonaws.com"}/${bucket}/${key}`;
  return { client, bucket, publicUrl };
}

/**
 * Streamed upload (ContentLength required for a stream Body with MinIO
 * forcePathStyle) — never readFileSync the re-encoded output into heap.
 * PutObject is atomic: a crash mid-upload never leaves a partial object
 * visible under the key, which is what makes the deterministic key safe.
 */
async function uploadVideoFile(s3: S3Target, key: string, filePath: string): Promise<string> {
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  await s3.client.send(new PutObjectCommand({
    Bucket: s3.bucket,
    Key: key,
    Body: createReadStream(filePath),
    ContentLength: statSync(filePath).size,
    ContentType: "video/mp4",
  }));
  return s3.publicUrl(key);
}

/**
 * Is a finished, REUSABLE artifact already stored under `key`?
 *
 * ⚠️ Only a positive, non-empty HeadObject that is younger than
 * META_READY_REUSE_MAX_AGE_MS is a hit. Any error — not-found or otherwise
 * (auth, network, throttling) — falls through to encoding: trusting an
 * unverified cache would hand Meta a URL that may not exist. An artifact near
 * its lifecycle expiry is a miss too; re-encoding it resets its age.
 */
async function artifactExists(s3: S3Target, key: string): Promise<boolean> {
  const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
  try {
    const head = await s3.client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: key }));
    const reusable = isReusableMetaReadyArtifact({
      contentLength: head.ContentLength,
      lastModified: head.LastModified,
      now: Date.now(),
    });
    if (!reusable && (head.ContentLength ?? 0) > 0) {
      console.log(`[VideoOverlay] ${key}: stored artifact is near its expiry — re-encoding to refresh it`);
    }
    return reusable;
  } catch (err: any) {
    const status = err?.$metadata?.httpStatusCode;
    const notFound = status === 404 || err?.name === "NotFound" || err?.name === "NoSuchKey";
    if (!notFound) {
      console.warn(`[VideoOverlay] ${key}: HeadObject failed (${err?.name ?? status}) — encoding instead of trusting the cache`);
    }
    return false;
  }
}

/**
 * Download the source to disk — STREAMED, never materialized in heap (the old
 * Buffer.from(arrayBuffer()) held up to the full video in RAM).
 *
 * `verifyLength` (shared path only): a stream that ends early resolves the
 * pipeline normally, and ffmpeg then encodes the short file without complaint.
 * On the shared path that artifact would be CACHED and reused by every later
 * target, so a size mismatch against Content-Length is a hard error there.
 */
async function downloadVideo(
  videoUrl: string,
  destPath: string,
  maxBytes: number | undefined,
  verifyLength: boolean
): Promise<"ok" | "oversized"> {
  const res = await fetch(videoUrl);
  if (!res.ok || !res.body) throw new Error(`Failed to download video: ${res.status}`);
  const len = parseInt(res.headers.get("content-length") ?? "", 10);
  if (maxBytes && Number.isFinite(len) && len > maxBytes) {
    await res.body.cancel().catch(() => undefined);
    console.warn(
      `[VideoOverlay] Remote video ${Math.round(len / 1024 / 1024)}MB exceeds overlay cap — posting original`
    );
    return "oversized";
  }
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(destPath));
  // A content-encoded body is decoded by fetch, so its on-disk size never
  // matches the (encoded) Content-Length — nothing to compare against there.
  const encoding = (res.headers.get("content-encoding") ?? "").toLowerCase();
  const comparable = !encoding || encoding === "identity";
  if (verifyLength && comparable && Number.isFinite(len)) {
    const written = statSync(destPath).size;
    if (written !== len) {
      throw new Error(`Short video download: wrote ${written} of ${len} bytes`);
    }
  }
  return "ok";
}

/**
 * Run the encode at LOW PRIORITY via `nice`. Encoding is throughput work;
 * serving the finished file to Instagram (nginx → MinIO) is latency work, and
 * on this 4-core box they compete. On 2026-08-07 sustained ffmpeg load starved
 * the serving path, so IG's own download ran long enough to blow the publish
 * poll budget. Renicing lets the encode use whatever is spare while
 * nginx/MinIO/Postgres stay responsive — throughput is preserved (no
 * concurrency reduction), only priority under contention changes.
 * `nice` is coreutils, present in the worker image; argv form (NO shell) keeps
 * the injection guarantee intact.
 */
async function runNicedFfmpeg(args: string[]): Promise<void> {
  await execFileAsync(
    "nice",
    ["-n", "10", "ffmpeg", ...args],
    { timeout: 180000, maxBuffer: 32 * 1024 * 1024 }
  );
}

/**
 * Container duration in seconds, or NaN when it cannot be read (ffprobe error,
 * or "N/A" — a browser MediaRecorder WebM carries no container duration).
 * Argv form, no shell, bounded.
 */
async function probeDurationSec(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", filePath],
      { timeout: 30_000, maxBuffer: 1024 * 1024 }
    );
    return parseFloat(String(stdout).trim());
  } catch (err: any) {
    console.warn(`[VideoOverlay] ffprobe failed for ${filePath}: ${err?.message}`);
    return NaN;
  }
}

function sha256hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// ── Filter graph (shared by both paths) ──────────────────────────────────────

function buildOverlayFilterGraph(p: {
  hasLogo: boolean;
  channelName?: string;
  text?: string;
  textPosition: TextPosition;
  textFontSize: number;
  logoPosition: LogoPosition;
  logoSize: number;
  storyCanvas: boolean;
  normalize: boolean;
}): string {
  const { hasLogo, channelName, text, textPosition, textFontSize, logoPosition, logoSize, storyCanvas, normalize } = p;
  const filters: string[] = [];

  // --- Story canvas (2026-09-16) ---
  // Meta does not normalise an organic story, so a non-9:16 clip is cropped by
  // the phone app and letterboxed on the web. Padding it to an exact 9:16
  // canvas makes every client render the same picture. Everything below then
  // draws on the finished canvas, so the watermark lands inside the frame.
  const baseLabel = storyCanvas ? "[vfit]" : "[0:v]";
  if (storyCanvas) {
    filters.push(buildStoryCanvasFilter("[0:v]", "[vfit]"));
  }

  // --- Logo overlay filter ---
  if (hasLogo) {
    const margin = 30;
    let overlayPos: string;
    switch (logoPosition) {
      case "top_left":    overlayPos = `${margin}:${margin}`; break;
      case "top_right":   overlayPos = `main_w-overlay_w-${margin}:${margin}`; break;
      case "bottom_left":  overlayPos = `${margin}:main_h-overlay_h-${margin}`; break;
      case "bottom_right":
      default:            overlayPos = `main_w-overlay_w-${margin}:main_h-overlay_h-${margin}`; break;
    }
    filters.push(`[1:v]scale=${logoSize}:-1[logo];${baseLabel}[logo]overlay=${overlayPos}[vlogo]`);
  } else if (channelName) {
    // Fallback: channel name as text watermark
    const escaped = channelName
      .replace(/'/g, "’")
      .replace(/:/g, "\\:")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]");
    const margin = 30;
    filters.push(`${baseLabel}drawtext=text='${escaped}':fontsize=28:fontcolor=white@0.7:x=w-text_w-${margin}:y=h-text_h-${margin}[vlogo]`);
  }

  // --- Text overlay filter (headline/supertext) ---
  if (text) {
    const escaped = text
      .replace(/\\/g, "\\\\\\\\")
      .replace(/'/g, "’")
      .replace(/:/g, "\\:")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]");

    let yExpr: string;
    const padding = 20;
    switch (textPosition) {
      case "top":    yExpr = `${padding}`; break;
      case "center": yExpr = "(h-text_h)/2"; break;
      case "bottom":
      default:       yExpr = `h-text_h-${padding * 4}`; break;
    }

    const inputLabel = (hasLogo || channelName) ? "[vlogo]" : baseLabel;
    filters.push(`${inputLabel}drawtext=text='${escaped}':fontsize=${textFontSize}:fontcolor=white:x=(w-text_w)/2:y=${yExpr}:box=1:boxcolor=black@0.6:boxborderw=${padding}[vout]`);
  } else if (hasLogo || channelName) {
    // No text, just rename the logo output
    filters.push(`[vlogo]null[vout]`);
  } else if (storyCanvas) {
    // Story padding with no watermark and no text: the canvas IS the output.
    filters.push(`[vfit]null[vout]`);
  } else if (normalize) {
    // Nothing drawn at all (2026-09-16): pass the frames through untouched so
    // the output still gets this pass's rate control / yuv420p / +faststart.
    filters.push(`[0:v]null[vout]`);
  }

  // The graph is ONE argv element (see buildOverlayFfmpegArgs) — the `escaped`
  // drawtext escaping above is correct for the ffmpeg FILTERGRAPH level; the
  // no-shell exec handles the (now-irrelevant) shell level.
  return filters.join(";");
}

// ── Shared, cached path (no per-channel input) ───────────────────────────────

/**
 * In-process de-duplication: concurrent targets asking for the same artifact
 * await ONE encode instead of each queueing their own behind the semaphore.
 * The entry is removed as soon as it settles (success OR failure), so a failed
 * encode is retried by the next caller rather than remembered.
 */
const inFlight = new Map<string, Promise<string>>();

async function runSharedMetaReady(
  videoUrl: string,
  o: {
    text?: string;
    textPosition: TextPosition;
    textFontSize: number;
    storyCanvas: boolean;
    maxBytes?: number;
  }
): Promise<string> {
  // Position/size only change the output when there is text to place, so they
  // are left out of the key otherwise — every normalize-only caller converges
  // on one object.
  const key = metaReadyObjectKey(
    {
      sourceUrl: videoUrl,
      text: o.text,
      textPosition: o.text ? o.textPosition : undefined,
      textFontSize: o.text ? o.textFontSize : undefined,
      storyCanvas: o.storyCanvas,
    },
    sha256hex
  );
  // maxBytes is not part of the OBJECT key (it never changes the output) but it
  // does change the decision to encode at all, so callers only share an
  // in-flight run when they agree on it.
  const flightKey = `${key}|${o.maxBytes ?? ""}`;
  const pending = inFlight.get(flightKey);
  if (pending) {
    console.log(`[VideoOverlay] ${key}: joining in-flight encode`);
    return pending;
  }
  const run = prepareSharedArtifact(videoUrl, key, o);
  inFlight.set(flightKey, run);
  const settle = () => {
    if (inFlight.get(flightKey) === run) inFlight.delete(flightKey);
  };
  // then(settle, settle) — NOT finally(): finally() returns a promise that
  // re-rejects, which would surface as an unhandled rejection here.
  run.then(settle, settle);
  return run;
}

async function prepareSharedArtifact(
  videoUrl: string,
  key: string,
  o: {
    text?: string;
    textPosition: TextPosition;
    textFontSize: number;
    storyCanvas: boolean;
    maxBytes?: number;
  }
): Promise<string> {
  const started = Date.now();
  const s3 = await s3Target();

  // Finished by an earlier target, retry or post: no semaphore, no download,
  // no encode.
  if (await artifactExists(s3, key)) {
    console.log(`[VideoOverlay] ${key}: reusing stored artifact (${Date.now() - started}ms)`);
    return s3.publicUrl(key);
  }

  return overlaySemaphore.run(async () => {
    const waitedMs = Date.now() - started;
    // Re-check: another process (or a pre-restart run) may have finished it
    // while this call queued.
    if (await artifactExists(s3, key)) {
      console.log(`[VideoOverlay] ${key}: stored while queued — reusing (waited ${waitedMs}ms)`);
      return s3.publicUrl(key);
    }

    if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
    const id = crypto.randomBytes(8).toString("hex");
    const inputPath = join(TMP_DIR, `input_${id}.mp4`);
    const outputPath = join(TMP_DIR, `output_${id}.mp4`);

    try {
      const download = await downloadVideo(videoUrl, inputPath, o.maxBytes, true);
      // The size decision is never cached — nothing is written.
      if (download === "oversized") return videoUrl;

      const filterComplex = buildOverlayFilterGraph({
        hasLogo: false,
        channelName: undefined,
        text: o.text,
        textPosition: o.textPosition,
        textFontSize: o.textFontSize,
        logoPosition: "bottom_right",
        logoSize: 120,
        storyCanvas: o.storyCanvas,
        normalize: true,
      });
      const args = buildOverlayFfmpegArgs({ inputArgs: ["-i", inputPath], filterComplex, outputPath });

      console.log(
        `[VideoOverlay] ${key}: encoding (text=${o.text ? "yes" : "no"}, storyCanvas=${o.storyCanvas ? "yes" : "no"}, waited ${waitedMs}ms)`
      );
      await runNicedFfmpeg(args);

      // Truncation guard. The artifact is about to be shared, so it must be
      // PROVEN whole before it is written where other targets will find it.
      const [inputSec, outputSec] = await Promise.all([
        probeDurationSec(inputPath),
        probeDurationSec(outputPath),
      ]);
      const storage = planMetaReadyStorage(inputSec, outputSec);
      if (storage === "reject") {
        throw new Error(`normalized video looks truncated: output ${outputSec}s vs source ${inputSec}s`);
      }
      let uploadKey = key;
      if (storage === "uncached") {
        // Unverifiable source length: behave exactly like the pre-2026-09-16
        // per-target pass (one-off key) and never share the result.
        uploadKey = `videos/overlay_${id}.mp4`;
        console.warn(`[VideoOverlay] ${key}: source duration unreadable — storing uncached as ${uploadKey}`);
      }

      const publicUrl = await uploadVideoFile(s3, uploadKey, outputPath);
      console.log(
        `[VideoOverlay] ${uploadKey}: done in ${Date.now() - started}ms (waited ${waitedMs}ms, ${inputSec}s → ${outputSec}s): ${publicUrl}`
      );
      return publicUrl;
    } finally {
      try { if (existsSync(inputPath)) unlinkSync(inputPath); } catch {}
      try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch {}
    }
  });
}

// ── Legacy per-target path (watermark: logo / channel name) ──────────────────

async function runLegacyOverlay(
  videoUrl: string,
  o: {
    text?: string;
    textPosition: TextPosition;
    textFontSize: number;
    logoUrl?: string | null;
    channelName?: string;
    logoPosition: LogoPosition;
    logoSize: number;
    maxBytes?: number;
    storyCanvas: boolean;
    normalize: boolean;
  }
): Promise<string> {
  const { text, logoUrl, channelName, maxBytes, storyCanvas } = o;
  const started = Date.now();

  return overlaySemaphore.run(async () => {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

  const id = crypto.randomBytes(8).toString("hex");
  const inputPath = join(TMP_DIR, `input_${id}.mp4`);
  const outputPath = join(TMP_DIR, `output_${id}.mp4`);
  const logoPath = join(TMP_DIR, `logo_${id}.png`);
  let hasLogo = false;

  try {
    // 1. Download video (streamed; no length verification on this path — its
    // output is never shared, and the behaviour stays as it was).
    const download = await downloadVideo(videoUrl, inputPath, maxBytes, false);
    if (download === "oversized") return videoUrl;

    // 2. Download logo if available
    if (logoUrl) {
      try {
        const logoRes = await fetch(logoUrl);
        if (logoRes.ok) {
          writeFileSync(logoPath, Buffer.from(await logoRes.arrayBuffer()));
          hasLogo = true;
        }
      } catch {
        console.warn(`[VideoOverlay] Could not download logo, using text watermark`);
      }
    }

    // 3. Build FFmpeg filter chain.
    // Discrete arg elements (NOT a shell string): each input is `-i` then the
    // RAW path — execFile passes each element verbatim, so no quoting.
    const inputArgs: string[] = ["-i", inputPath];
    if (hasLogo) {
      inputArgs.push("-i", logoPath);
    }
    const filterComplex = buildOverlayFilterGraph({
      hasLogo,
      channelName,
      text,
      textPosition: o.textPosition,
      textFontSize: o.textFontSize,
      logoPosition: o.logoPosition,
      logoSize: o.logoSize,
      storyCanvas,
      normalize: o.normalize,
    });

    // 4. Build FFmpeg args (ARRAY, not a shell string) and run with async
    // execFile (NO shell) — closes command injection via user-controlled
    // text/channelName baked into filterComplex.
    const args = buildOverlayFfmpegArgs({ inputArgs, filterComplex, outputPath });

    console.log(`[VideoOverlay] legacy: Processing: logo=${hasLogo ? "yes" : channelName ? "text" : "none"}, text=${text ? "yes" : "no"}, waited ${Date.now() - started}ms`);
    await runNicedFfmpeg(args);

    // 5. Upload to S3 under a one-off key — the output carries this target's
    // own watermark, so it can never be shared.
    const s3 = await s3Target();
    const key = `videos/overlay_${id}.mp4`;
    const publicUrl = await uploadVideoFile(s3, key, outputPath);

    console.log(`[VideoOverlay] legacy: Done in ${Date.now() - started}ms: ${publicUrl}`);
    return publicUrl;
  } finally {
    try { if (existsSync(inputPath)) unlinkSync(inputPath); } catch {}
    try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch {}
    try { if (existsSync(logoPath)) unlinkSync(logoPath); } catch {}
  }
  }); // overlaySemaphore.run
}
