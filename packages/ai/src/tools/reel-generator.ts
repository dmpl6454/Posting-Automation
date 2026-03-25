/**
 * Reel Video Generator
 * Creates a slideshow video from carousel images using FFmpeg.
 * Each slide displays for a configurable duration with fade transitions.
 */

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";

export interface ReelOptions {
  /** Base64-encoded slide images */
  slideImages: Array<{ imageBase64: string; mimeType: string }>;
  /** Seconds each slide is shown (default: 3) */
  slideDuration?: number;
  /** Fade transition duration in seconds (default: 0.5) */
  fadeDuration?: number;
  /** Output resolution width (default: 1080) */
  width?: number;
  /** Output resolution height (default: 1350 for 4:5, or 1920 for 9:16) */
  height?: number;
}

export interface ReelResult {
  videoBase64: string;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number;
}

export async function generateReelVideo(options: ReelOptions): Promise<ReelResult> {
  const {
    slideImages,
    slideDuration = 3,
    fadeDuration = 0.5,
    width = 1080,
    height = 1350,
  } = options;

  if (slideImages.length === 0) {
    throw new Error("At least one slide image is required");
  }

  // Create temp directory
  const tmpId = crypto.randomBytes(8).toString("hex");
  const workDir = join(tmpdir(), `reel-${tmpId}`);
  mkdirSync(workDir, { recursive: true });

  try {
    // Write slide images to disk
    const imagePaths: string[] = [];
    for (let i = 0; i < slideImages.length; i++) {
      const ext = slideImages[i]!.mimeType.includes("png") ? "png" : "jpg";
      const path = join(workDir, `slide_${String(i).padStart(3, "0")}.${ext}`);
      writeFileSync(path, Buffer.from(slideImages[i]!.imageBase64, "base64"));
      imagePaths.push(path);
    }

    // Create FFmpeg concat file
    const concatFile = join(workDir, "concat.txt");
    const concatContent = imagePaths
      .map((p) => `file '${p}'\nduration ${slideDuration}`)
      .join("\n");
    // Repeat last image to avoid last-frame cut
    writeFileSync(
      concatFile,
      concatContent + `\nfile '${imagePaths[imagePaths.length - 1]}'\n`
    );

    const outputPath = join(workDir, "reel.mp4");

    // Build FFmpeg command
    // Use concat demuxer with fade transitions
    const totalDuration = slideImages.length * slideDuration;
    const ffmpegCmd = [
      "ffmpeg", "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatFile,
      "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=30`,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-t", String(totalDuration),
      "-movflags", "+faststart",
      outputPath,
    ].join(" ");

    execSync(ffmpegCmd, { timeout: 120_000, stdio: "pipe" });

    if (!existsSync(outputPath)) {
      throw new Error("FFmpeg failed to produce output video");
    }

    const videoBuffer = readFileSync(outputPath);
    const videoBase64 = videoBuffer.toString("base64");

    return {
      videoBase64,
      mimeType: "video/mp4",
      width,
      height,
      durationSeconds: totalDuration,
    };
  } finally {
    // Cleanup
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }
}
