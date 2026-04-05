/**
 * Reel Video Generator
 * Creates a slideshow video from carousel images using FFmpeg.
 * Supports voice-over narration and background music.
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
  /** Voice-over audio (base64-encoded MP3) */
  voiceOverBase64?: string;
  /** Background music URL or base64 (mp3) */
  bgMusicBase64?: string;
  /** Background music volume 0.0-1.0 (default: 0.15) */
  bgMusicVolume?: number;
  /** Voice-over volume 0.0-1.0 (default: 0.9) */
  voiceVolume?: number;
}

export interface ReelResult {
  videoBase64: string;
  mimeType: string;
  width: number;
  height: number;
  durationSeconds: number;
}

/** Fetch a public URL to a local file */
async function downloadToFile(url: string, filePath: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(filePath, buf);
}

export async function generateReelVideo(options: ReelOptions): Promise<ReelResult> {
  const {
    slideImages,
    slideDuration = 3,
    width = 1080,
    height = 1350,
    voiceOverBase64,
    bgMusicBase64,
    bgMusicVolume = 0.15,
    voiceVolume = 0.9,
  } = options;

  if (slideImages.length === 0) {
    throw new Error("At least one slide image is required");
  }

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
    writeFileSync(
      concatFile,
      concatContent + `\nfile '${imagePaths[imagePaths.length - 1]}'\n`
    );

    const totalDuration = slideImages.length * slideDuration;

    // Write voice-over audio if provided
    const voicePath = join(workDir, "voice.mp3");
    const hasVoice = !!voiceOverBase64;
    if (hasVoice) {
      writeFileSync(voicePath, Buffer.from(voiceOverBase64, "base64"));
    }

    // Write background music if provided
    const bgMusicPath = join(workDir, "bgmusic.mp3");
    const hasBgMusic = !!bgMusicBase64;
    if (hasBgMusic) {
      writeFileSync(bgMusicPath, Buffer.from(bgMusicBase64, "base64"));
    }

    const outputPath = join(workDir, "reel.mp4");

    // Build FFmpeg command based on audio availability
    let ffmpegCmd: string;

    if (hasVoice && hasBgMusic) {
      // Video + voice-over + background music
      // Mix voice and music, then combine with video
      ffmpegCmd = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0", "-i", concatFile,
        "-i", voicePath,
        "-i", bgMusicPath,
        "-filter_complex",
        `'[1:a]volume=${voiceVolume}[voice];` +
        `[2:a]volume=${bgMusicVolume},aloop=loop=-1:size=2e+09[music];` +
        `[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]'`,
        "-map", "0:v",
        "-map", "[aout]",
        "-vf", `'scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=30'`,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-t", String(totalDuration),
        "-movflags", "+faststart",
        "-shortest",
        outputPath,
      ].join(" ");
    } else if (hasVoice) {
      // Video + voice-over only
      ffmpegCmd = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0", "-i", concatFile,
        "-i", voicePath,
        "-map", "0:v",
        "-map", "1:a",
        "-vf", `'scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=30'`,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "192k",
        "-af", `volume=${voiceVolume}`,
        "-pix_fmt", "yuv420p",
        "-t", String(totalDuration),
        "-movflags", "+faststart",
        "-shortest",
        outputPath,
      ].join(" ");
    } else if (hasBgMusic) {
      // Video + background music only
      ffmpegCmd = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0", "-i", concatFile,
        "-i", bgMusicPath,
        "-map", "0:v",
        "-map", "1:a",
        "-vf", `'scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=30'`,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "192k",
        "-af", `volume=${bgMusicVolume}`,
        "-pix_fmt", "yuv420p",
        "-t", String(totalDuration),
        "-movflags", "+faststart",
        "-shortest",
        outputPath,
      ].join(" ");
    } else {
      // Video only (no audio)
      ffmpegCmd = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0", "-i", concatFile,
        "-vf", `'scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=30'`,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-t", String(totalDuration),
        "-movflags", "+faststart",
        outputPath,
      ].join(" ");
    }

    execSync(ffmpegCmd, { timeout: 180_000, stdio: "pipe" });

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
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }
}
