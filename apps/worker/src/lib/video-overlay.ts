import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import crypto from "crypto";

const TMP_DIR = "/tmp/video-overlay";

/**
 * Add text overlay to a video using FFmpeg.
 * Downloads the video, burns in text, uploads to S3, returns new URL.
 */
export async function addTextOverlayToVideo(
  videoUrl: string,
  text: string,
  options: {
    position?: "top" | "center" | "bottom"; // default: bottom
    fontSize?: number;    // default: 48
    fontColor?: string;   // default: white
    bgColor?: string;     // default: black@0.6
    padding?: number;     // default: 20
  } = {}
): Promise<string> {
  const {
    position = "bottom",
    fontSize = 48,
    fontColor = "white",
    bgColor = "black@0.6",
    padding = 20,
  } = options;

  // Ensure tmp dir exists
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

  const id = crypto.randomBytes(8).toString("hex");
  const inputPath = join(TMP_DIR, `input_${id}.mp4`);
  const outputPath = join(TMP_DIR, `output_${id}.mp4`);

  try {
    // 1. Download video
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error(`Failed to download video: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(inputPath, buffer);

    // 2. Escape text for FFmpeg drawtext filter
    const escapedText = text
      .replace(/\\/g, "\\\\\\\\")
      .replace(/'/g, "\u2019")   // smart quote instead of escaping
      .replace(/:/g, "\\:")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]");

    // 3. Calculate Y position
    let yExpr: string;
    switch (position) {
      case "top":
        yExpr = `${padding}`;
        break;
      case "center":
        yExpr = "(h-text_h)/2";
        break;
      case "bottom":
      default:
        yExpr = `h-text_h-${padding * 3}`;
        break;
    }

    // 4. Build FFmpeg command
    const drawtext = `drawtext=text='${escapedText}':fontsize=${fontSize}:fontcolor=${fontColor}:x=(w-text_w)/2:y=${yExpr}:box=1:boxcolor=${bgColor}:boxborderw=${padding}`;

    const cmd = `ffmpeg -y -i "${inputPath}" -vf "${drawtext}" -codec:a copy -preset ultrafast -movflags +faststart "${outputPath}"`;

    console.log(`[VideoOverlay] Processing video with text: "${text.slice(0, 50)}..."`);
    execSync(cmd, { timeout: 120000, stdio: "pipe" });

    // 5. Upload processed video to S3
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const { readFileSync } = await import("fs");

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
    const outputBuffer = readFileSync(outputPath);

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: outputBuffer,
      ContentType: "video/mp4",
    }));

    // Build public URL
    let publicUrl: string;
    if (process.env.S3_PUBLIC_URL) {
      publicUrl = `${process.env.S3_PUBLIC_URL}/${key}`;
    } else {
      publicUrl = `${process.env.S3_ENDPOINT || "https://s3.amazonaws.com"}/${bucket}/${key}`;
    }

    console.log(`[VideoOverlay] Processed video uploaded: ${publicUrl}`);
    return publicUrl;
  } finally {
    // Cleanup temp files
    try { if (existsSync(inputPath)) unlinkSync(inputPath); } catch {}
    try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch {}
  }
}
