import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import crypto from "crypto";

// Async ffmpeg (stability guard, 2026-07-18): the sync encode blocked the whole
// worker event loop (every queue) for up to 180s. Same argv-array/no-shell
// pattern, promisified (proven in packages/ai/src/tools/reel-generator.ts).
const execFileAsync = promisify(execFile);

const TMP_DIR = "/tmp/video-overlay";

/**
 * Build the ffmpeg argument ARRAY for the overlay pass (pure — no I/O).
 *
 * SECURITY: every element is a discrete, UNQUOTED arg. With `execFile`
 * (no shell) each array element is passed verbatim, so shell metachars in
 * the (user-controlled) `text`/`channelName` baked into `filterComplex` are
 * inert. Do NOT wrap any element in shell quotes — quotes would become part
 * of the literal filename / filtergraph value.
 *   - `inputArgs` is already discrete (`["-i", path1, "-i", path2, ...]`).
 *   - `filterComplex` is ONE element (do not split / quote).
 *   - `[vout]` and `outputPath` are their own UNQUOTED elements.
 */
export function buildOverlayFfmpegArgs(opts: {
  inputArgs: string[];
  filterComplex: string;
  outputPath: string;
}): string[] {
  return [
    "-y",
    ...opts.inputArgs,
    "-filter_complex",
    opts.filterComplex,
    "-map",
    "[vout]",
    "-map",
    "0:a?",
    "-codec:a",
    "copy",
    "-preset",
    "ultrafast",
    "-movflags",
    "+faststart",
    opts.outputPath,
  ];
}

interface VideoOverlayOptions {
  text?: string;              // headline/supertext to burn on video
  textPosition?: "top" | "center" | "bottom";
  textFontSize?: number;
  logoUrl?: string | null;    // channel logo URL to watermark
  channelName?: string;       // fallback watermark text if no logo
  logoPosition?: "top_left" | "top_right" | "bottom_left" | "bottom_right";
  logoSize?: number;          // logo width in pixels (default 120)
}

/**
 * Add logo watermark and/or text overlay to a video using FFmpeg.
 * Downloads video, processes it, uploads to S3, returns new URL.
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
  } = options;

  if (!text && !logoUrl && !channelName) return videoUrl; // nothing to do

  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

  const id = crypto.randomBytes(8).toString("hex");
  const inputPath = join(TMP_DIR, `input_${id}.mp4`);
  const outputPath = join(TMP_DIR, `output_${id}.mp4`);
  const logoPath = join(TMP_DIR, `logo_${id}.png`);
  let hasLogo = false;

  try {
    // 1. Download video
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`Failed to download video: ${res.status}`);
    writeFileSync(inputPath, Buffer.from(await res.arrayBuffer()));

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

    // 3. Build FFmpeg filter chain
    const filters: string[] = [];
    // Discrete arg elements (NOT a shell string): each input is `-i` then the
    // RAW path — execFileSync passes each element verbatim, so no quoting.
    const inputArgs: string[] = ["-i", inputPath];

    if (hasLogo) {
      inputArgs.push("-i", logoPath);
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
      filters.push(`[1:v]scale=${logoSize}:-1[logo];[0:v][logo]overlay=${overlayPos}[vlogo]`);
    } else if (channelName) {
      // Fallback: channel name as text watermark
      const escaped = channelName
        .replace(/'/g, "\u2019")
        .replace(/:/g, "\\:")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]");
      const margin = 30;
      filters.push(`[0:v]drawtext=text='${escaped}':fontsize=28:fontcolor=white@0.7:x=w-text_w-${margin}:y=h-text_h-${margin}[vlogo]`);
    }

    // --- Text overlay filter (headline/supertext) ---
    if (text) {
      const escaped = text
        .replace(/\\/g, "\\\\\\\\")
        .replace(/'/g, "\u2019")
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

      const inputLabel = (hasLogo || channelName) ? "[vlogo]" : "[0:v]";
      filters.push(`${inputLabel}drawtext=text='${escaped}':fontsize=${textFontSize}:fontcolor=white:x=(w-text_w)/2:y=${yExpr}:box=1:boxcolor=black@0.6:boxborderw=${padding}[vout]`);
    } else if (hasLogo || channelName) {
      // No text, just rename the logo output
      filters.push(`[vlogo]null[vout]`);
    }

    // 4. Build FFmpeg args (ARRAY, not a shell string) and run with async execFile
    // (NO shell) — closes command injection via user-controlled text/channelName
    // baked into filterComplex. The `escaped` drawtext escaping above stays:
    // it's correct for the ffmpeg FILTERGRAPH level; the no-shell exec handles
    // the (now-irrelevant) shell level. Awaited so the encode doesn't freeze the
    // worker's event loop (identical argv + timeout as the old sync call).
    const filterComplex = filters.join(";");
    const args = buildOverlayFfmpegArgs({ inputArgs, filterComplex, outputPath });

    console.log(`[VideoOverlay] Processing: logo=${hasLogo ? "yes" : channelName ? "text" : "none"}, text=${text ? "yes" : "no"}`);
    await execFileAsync("ffmpeg", args, { timeout: 180000, maxBuffer: 32 * 1024 * 1024 });

    // 5. Upload to S3
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({
      region: process.env.S3_REGION || "us-east-1",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || "",
      },
    });

    const bucket = process.env.S3_BUCKET || "postautomation-media";
    const key = `videos/overlay_${id}.mp4`;

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: readFileSync(outputPath),
      ContentType: "video/mp4",
    }));

    let publicUrl: string;
    if (process.env.S3_PUBLIC_URL) {
      publicUrl = `${process.env.S3_PUBLIC_URL}/${key}`;
    } else {
      publicUrl = `${process.env.S3_ENDPOINT || "https://s3.amazonaws.com"}/${bucket}/${key}`;
    }

    console.log(`[VideoOverlay] Done: ${publicUrl}`);
    return publicUrl;
  } finally {
    try { if (existsSync(inputPath)) unlinkSync(inputPath); } catch {}
    try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch {}
    try { if (existsSync(logoPath)) unlinkSync(logoPath); } catch {}
  }
}
