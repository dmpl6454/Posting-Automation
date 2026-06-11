import { Worker, type Job } from "bullmq";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "@postautomation/db";
import {
  QUEUE_NAMES,
  type RepurposeVideoJobData,
  createRedisConnection,
  scopedProgressId,
  pushProgress,
  finishProgress,
} from "@postautomation/queue";
import {
  generateReelVideo,
  generateSeedanceVideo,
  buildSeedancePrompt,
} from "@postautomation/ai";
import {
  buildVideoReadyDetail,
  friendlyVideoError,
  escapeDrawText,
  buildCaptionDrawtextFilters,
} from "../lib/repurpose-video";

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

async function uploadVideoToS3(buffer: Buffer, key: string): Promise<string> {
  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: "video/mp4",
      CacheControl: "public, max-age=31536000",
    })
  );
  return `${S3_BASE_URL}/${key}`;
}

/** Download a remote URL into a Buffer (used for Seedance MP4 before the caption burn). */
async function downloadToBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Download a remote URL to a base64 string (used for reel slide images). */
async function downloadToBase64(url: string): Promise<{ imageBase64: string; mimeType: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  const mimeType = res.headers.get("content-type") || "image/png";
  const buf = Buffer.from(await res.arrayBuffer());
  return { imageBase64: buf.toString("base64"), mimeType };
}

/**
 * Burn a CLEAN lower-third onto the Seedance-generated MP4 via an ffmpeg
 * `drawtext` pass. The Seedance model now renders VISUALS ONLY (no in-video
 * text — fixed via the prompt), so we overlay the readable caption layer here:
 * a PERSISTENT title line plus ONE time-sliced scene caption at a time (the
 * scene rotates across equal windows of the clip), so at most two lines ever
 * show at once instead of the old permanently-stacked block.
 */
function burnCaptionsOnVideo(
  videoBuf: Buffer,
  opts: { title: string; scenes: string[]; durationSeconds: number }
): Buffer {
  // Build the ordered drawtext filters (pure, unit-tested in lib/repurpose-video).
  // escapeDrawText is applied to EVERY caption TEXT value inside the helper;
  // the time-slice between(...) windows are computed numbers (never user input).
  const filters = buildCaptionDrawtextFilters(opts, escapeDrawText);
  if (filters.length === 0) return videoBuf; // nothing to burn

  const tmpId = crypto.randomBytes(8).toString("hex");
  const workDir = join(tmpdir(), `seedance-caption-${tmpId}`);
  mkdirSync(workDir, { recursive: true });
  const inputPath = join(workDir, "in.mp4");
  const outputPath = join(workDir, "out.mp4");

  try {
    writeFileSync(inputPath, videoBuf);

    // Join the filters into the single `-vf` filtergraph element. The commas
    // here separate the drawtext filters; the commas INSIDE between(t,A,B) are
    // protected by that expression's own filtergraph-level single quotes.
    const drawtexts = filters.join(",");

    // SECURITY: run ffmpeg with execFileSync (NO shell) so attacker-influenceable
    // caption text (from the user-supplied URL's article) can never reach /bin/sh.
    // Each flag/value is its own array element; the `-vf` filter is ONE unquoted
    // element (no shell quoting needed); paths are their own unquoted elements.
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-i",
        inputPath,
        "-vf",
        drawtexts,
        "-map",
        "0:v",
        "-map",
        "0:a?",
        "-codec:a",
        "copy",
        "-preset",
        "ultrafast",
        "-movflags",
        "+faststart",
        outputPath,
      ],
      { timeout: 180_000, stdio: "pipe" }
    );

    if (!existsSync(outputPath)) {
      throw new Error("ffmpeg failed to produce captioned video");
    }
    return readFileSync(outputPath);
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  }
}

export function createRepurposeVideoWorker() {
  const worker = new Worker<RepurposeVideoJobData>(
    QUEUE_NAMES.REPURPOSE_VIDEO,
    async (job: Job<RepurposeVideoJobData>) => {
      const { userId, organizationId, format, theme } = job.data;
      // job.data.progressId is the RAW client id (`rep-...`, NOT pre-scoped) per
      // the job-data contract. Scope it EXACTLY ONCE here to match the SSE reader
      // (apps/web/app/api/progress/route.ts), which also scopes the raw `rep-` id
      // a single time as `${userId}:${id}`. Scoping twice would yield
      // `userId:userId:rep-...` and never match the reader's key.
      const scoped = scopedProgressId(userId, job.data.progressId);
      console.log(`[RepurposeVideo] Processing job ${job.id}: format=${format} for org ${organizationId}`);

      let videoBuf: Buffer;
      let durationSeconds: number;

      try {
        if (format === "reel") {
          await pushProgress(scoped, "Stitching reel video", "running");
          const reel = job.data.reel;
          if (!reel || reel.slideUrls.length === 0) {
            throw new Error("Reel job is missing slide images.");
          }

          // Download each slide to base64 for the ffmpeg stitch.
          const slideImages: Array<{ imageBase64: string; mimeType: string }> = [];
          for (const url of reel.slideUrls) {
            slideImages.push(await downloadToBase64(url));
          }

          // Voice-over (TTS from the supplied script) — best-effort.
          let voiceOverBase64: string | undefined;
          if (reel.voiceOver && reel.voiceScript) {
            try {
              const { generateSpeech } = await import("@postautomation/ai");
              const tts = await generateSpeech({
                text: reel.voiceScript,
                voice: (reel.voiceType as any) || "alloy",
                speed: 1.0,
                model: "tts-1-hd",
              });
              voiceOverBase64 = tts.audioBase64;
            } catch (ttsErr) {
              console.warn(`[RepurposeVideo] Voice-over failed:`, (ttsErr as Error).message);
            }
          }

          // Background music (synthesized tone bed) — best-effort, mirrors router.
          let bgMusicBase64: string | undefined;
          if (reel.bgMusic) {
            try {
              const dur = slideImages.length * 3 + 2;
              const musicDir = join(tmpdir(), `bgmusic-${crypto.randomBytes(4).toString("hex")}`);
              mkdirSync(musicDir, { recursive: true });
              const musicPath = join(musicDir, "bg.mp3");
              // execFileSync (NO shell) — `dur` is a number, but keep the no-shell
              // invariant consistent across every ffmpeg call in this worker.
              execFileSync(
                "ffmpeg",
                [
                  "-y",
                  "-f",
                  "lavfi",
                  "-i",
                  `sine=frequency=110:duration=${dur}`,
                  "-f",
                  "lavfi",
                  "-i",
                  `sine=frequency=165:duration=${dur}`,
                  "-filter_complex",
                  `[0:a][1:a]amix=inputs=2,volume=0.3,afade=t=in:d=1,afade=t=out:st=${dur - 1}:d=1[out]`,
                  "-map",
                  "[out]",
                  "-c:a",
                  "libmp3lame",
                  "-b:a",
                  "128k",
                  musicPath,
                ],
                { timeout: 30_000, stdio: "pipe" }
              );
              bgMusicBase64 = readFileSync(musicPath).toString("base64");
              rmSync(musicDir, { recursive: true, force: true });
            } catch (musicErr) {
              console.warn(`[RepurposeVideo] Background music failed:`, (musicErr as Error).message);
            }
          }

          const reelResult = await generateReelVideo({
            slideImages,
            slideDuration: 3,
            width: 1080,
            // Parity with the original synchronous reel branch (repurpose.router.ts):
            // slides are rendered at 1080×1350 (4:5), so the reel height is a FIXED
            // 1350 regardless of theme. Full 9:16 (1080×1920) would require
            // regenerating slides at that size — out of scope here.
            height: 1350,
            voiceOverBase64,
            bgMusicBase64,
            bgMusicVolume: 0.15,
            voiceVolume: 0.9,
          });
          videoBuf = Buffer.from(reelResult.videoBase64, "base64");
          durationSeconds = reelResult.durationSeconds;
          // Re-publish "done" so the activity-log spinner flips to a checkmark
          // (the client dedupes by step name).
          await pushProgress(scoped, "Stitching reel video", "done");
        } else if (format === "seedance_video") {
          await pushProgress(scoped, "Generating AI video (Seedance)", "running");
          const sd = job.data.seedance;
          if (!sd) {
            throw new Error("Seedance job is missing scene data.");
          }

          const musicMood =
            theme === "dark" ? "dramatic cinematic, deep bass, orchestral"
            : theme === "gradient" ? "upbeat electronic, modern synth"
            : "clean corporate, optimistic";

          const prompt = buildSeedancePrompt({
            title: sd.title.slice(0, 60),
            keyPoints: sd.scenes,
            visualStyle: `${theme} theme, professional social media video, cinematic B-roll`,
            musicMood,
          });

          // The long (~up to 7.5min) poll now runs HERE, off the request thread.
          const seed = await generateSeedanceVideo({
            prompt,
            duration: sd.duration,
            aspectRatio: "9:16",
            onProgress: ({ elapsedSeconds, status }) => {
              void pushProgress(scoped, "Generating AI video (Seedance)", "running", `${elapsedSeconds}s — ${status}`);
            },
          });

          // Generation finished — flip the spinner to a checkmark before the
          // caption pass (the client dedupes by step name).
          await pushProgress(scoped, "Generating AI video (Seedance)", "done", `${sd.duration}s clip`);

          // Burn a CLEAN lower-third: the Seedance model now renders visuals
          // only, so the readable title (persistent) + ONE rotating scene caption
          // (time-sliced) are overlaid here via ffmpeg drawtext.
          await pushProgress(scoped, "Adding captions", "running");
          const raw = seed.videoUrl ? await downloadToBuffer(seed.videoUrl) : Buffer.from(seed.videoBase64, "base64");
          videoBuf = burnCaptionsOnVideo(raw, {
            title: sd.title,
            scenes: sd.scenes.slice(0, 4),
            durationSeconds: sd.duration,
          });
          await pushProgress(scoped, "Adding captions", "done");
          durationSeconds = seed.durationSeconds;
        } else {
          throw new Error(`Unsupported repurpose-video format: ${format}`);
        }

        // Upload + create Media row (matches repurpose router's video Media shape).
        await pushProgress(scoped, "Uploading video", "running", `${(videoBuf.length / 1024 / 1024).toFixed(1)}MB`);
        const key = `repurpose/${format}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp4`;
        const url = await uploadVideoToS3(videoBuf, key);
        // Upload finished — flip the spinner to a checkmark before the terminal
        // video_ready event (the client dedupes by step name).
        await pushProgress(scoped, "Uploading video", "done", `${(videoBuf.length / 1024 / 1024).toFixed(1)}MB`);

        const media = await prisma.media.create({
          data: {
            organizationId,
            uploadedById: userId,
            fileName: `${format}-${Date.now()}.mp4`,
            fileType: "video/mp4",
            fileSize: videoBuf.length,
            url,
            duration: durationSeconds,
          },
        });

        await pushProgress(scoped, "video_ready", "done", buildVideoReadyDetail(media.id, media.url, format));
        await finishProgress(scoped, "done");
        console.log(`[RepurposeVideo] Job ${job.id} done — media ${media.id} (${(videoBuf.length / 1024 / 1024).toFixed(1)}MB)`);
        return media.id;
      } catch (e) {
        const msg = friendlyVideoError(e);
        // Publish the error to the progress stream — but never let a Redis
        // hiccup here mask the real failure that BullMQ must record.
        try {
          await pushProgress(scoped, "video_error", "error", msg);
          await finishProgress(scoped, "error");
        } catch (progressErr) {
          console.warn(`[RepurposeVideo] progress-publish failed:`, (progressErr as Error).message);
        }
        console.error(`[RepurposeVideo] Job ${job.id} failed:`, (e as Error).message);
        throw e; // record the failure in BullMQ
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 2,
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 1000 },
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[RepurposeVideo] Job ${job?.id} failed (${job?.data.format}):`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[RepurposeVideo] Job ${job.id} completed (${job.data.format})`);
  });

  return worker;
}
