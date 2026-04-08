/**
 * Seedance 1.5 Pro Video Generation Provider (ByteDance)
 * Uses fal.ai queue API for text-to-video
 * Model: fal-ai/bytedance/seedance/v1.5/pro/text-to-video
 *
 * Flow:
 * 1. POST to queue → get request_id
 * 2. Poll status until COMPLETED
 * 3. Fetch result → get video URL (response.video.url)
 * 4. Download video bytes
 */

const FAL_QUEUE_BASE = "https://queue.fal.run";
const MODEL_ID = "fal-ai/bytedance/seedance/v1.5/pro/text-to-video";

export interface SeedanceGenerateParams {
  prompt: string;
  /** Duration in seconds (4-12, default: 5) */
  duration?: number;
  /** Aspect ratio (default: "9:16" for reels) */
  aspectRatio?: "21:9" | "16:9" | "9:16" | "4:3" | "3:4" | "1:1";
  /** Resolution (default: "720p") */
  resolution?: "480p" | "720p";
  /** Seed for reproducibility (-1 for random) */
  seed?: number;
  /** Enable native audio generation (default: true) */
  enableAudio?: boolean;
  /** Lock camera (tripod shot) */
  cameraFixed?: boolean;
}

export interface SeedanceResult {
  videoBase64: string;
  mimeType: string;
  durationSeconds: number;
  videoUrl?: string;
  seed?: number;
}

function getApiKey(): string {
  const key = process.env.FAL_KEY || process.env.FAL_API_KEY;
  if (!key) {
    throw new Error("FAL_KEY is required for Seedance video generation");
  }
  return key;
}

/**
 * Generate a video using Seedance 1.5 Pro
 */
export async function generateSeedanceVideo(params: SeedanceGenerateParams): Promise<SeedanceResult> {
  const apiKey = getApiKey();

  // Step 1: Submit to queue
  const submitUrl = `${FAL_QUEUE_BASE}/${MODEL_ID}`;

  const duration = Math.max(4, Math.min(12, params.duration || 5));

  const body: Record<string, unknown> = {
    prompt: params.prompt,
    aspect_ratio: params.aspectRatio || "9:16",
    duration,
    resolution: params.resolution || "720p",
    generate_audio: params.enableAudio !== false,
  };

  if (params.cameraFixed) {
    body.camera_fixed = true;
  }

  if (params.seed !== undefined) {
    body.seed = params.seed;
  }

  console.log(`[Seedance] Submitting video generation: "${params.prompt.slice(0, 80)}..." (${duration}s, ${body.aspect_ratio})`);

  const submitRes = await fetch(submitUrl, {
    method: "POST",
    headers: {
      "Authorization": `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text();
    throw new Error(`Seedance submit failed (${submitRes.status}): ${errText}`);
  }

  const submitData = await submitRes.json();
  const requestId = submitData.request_id;

  if (!requestId) {
    throw new Error("Seedance did not return a request_id");
  }

  console.log(`[Seedance] Request submitted: ${requestId}`);

  // Step 2: Poll until completed (video gen takes 30s-3min)
  const MAX_POLLS = 72; // 6 min max
  const POLL_INTERVAL = 5000; // 5s
  let completed = false;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));

    const statusUrl = `${FAL_QUEUE_BASE}/${MODEL_ID}/requests/${requestId}/status`;
    const statusRes = await fetch(statusUrl, {
      headers: { "Authorization": `Key ${apiKey}` },
    });

    if (!statusRes.ok) {
      const errText = await statusRes.text();
      console.warn(`[Seedance] Status poll failed (${statusRes.status}): ${errText}`);
      continue;
    }

    const statusData = await statusRes.json();

    if (statusData.status === "COMPLETED") {
      console.log(`[Seedance] Generation completed after ${((i + 1) * POLL_INTERVAL) / 1000}s`);
      completed = true;
      break;
    }

    if (statusData.status === "FAILED") {
      throw new Error(`Seedance generation failed: ${statusData.error || "Unknown error"}`);
    }

    // Log progress every 30s
    if (i % 6 === 0) {
      const elapsed = ((i + 1) * POLL_INTERVAL) / 1000;
      console.log(`[Seedance] Still generating... (${elapsed}s, status: ${statusData.status})`);
    }
  }

  if (!completed) {
    throw new Error("Seedance generation timed out after 6 minutes");
  }

  // Step 3: Fetch result
  const resultUrl = `${FAL_QUEUE_BASE}/${MODEL_ID}/requests/${requestId}`;
  const resultRes = await fetch(resultUrl, {
    headers: { "Authorization": `Key ${apiKey}` },
  });

  if (!resultRes.ok) {
    const errText = await resultRes.text();
    throw new Error(`Seedance result fetch failed (${resultRes.status}): ${errText}`);
  }

  const resultData = await resultRes.json();

  // Response format: { video: { url: "..." }, seed: 42 }
  const videoUrl = resultData.video?.url;

  if (!videoUrl) {
    console.error(`[Seedance] No video URL in result: ${JSON.stringify(resultData).slice(0, 1000)}`);
    throw new Error("Seedance returned no video URL");
  }

  console.log(`[Seedance] Video ready: ${videoUrl}`);

  // Step 4: Download video
  const downloadRes = await fetch(videoUrl);
  if (!downloadRes.ok) {
    throw new Error(`Seedance video download failed: ${downloadRes.status}`);
  }

  const videoBuf = Buffer.from(await downloadRes.arrayBuffer());
  console.log(`[Seedance] Downloaded video: ${(videoBuf.length / 1024 / 1024).toFixed(1)}MB`);

  return {
    videoBase64: videoBuf.toString("base64"),
    mimeType: "video/mp4",
    durationSeconds: duration,
    videoUrl,
    seed: resultData.seed,
  };
}

/**
 * Build a Seedance-optimized video prompt
 */
export function buildSeedancePrompt(opts: {
  title: string;
  keyPoints: string[];
  visualStyle?: string;
  musicMood?: string;
  brandName?: string;
}): string {
  const style = opts.visualStyle || "cinematic, professional, modern";
  const music = opts.musicMood || "upbeat corporate, subtle electronic";

  const scenes = opts.keyPoints
    .map((point, i) => `Scene ${i + 2}: Bold white text "${point}" centered on screen over dramatic cinematic B-roll. Narrator reads the text.`)
    .join("\n");

  return `Create a VERTICAL 9:16 social media video with bold text overlays and cinematic visuals.

Style: ${style}

Scene 1: Opening — enormous bold white title "${opts.title}" zooms in with dramatic camera push. Dark cinematic background. Narrator introduces the topic.
${scenes}
Final scene: Call-to-action "${opts.brandName || "Follow for More"}" with dynamic typography animation.

Camera: Smooth dolly movements, subtle parallax, cinematic rack focus transitions between scenes.
Audio: ${music} background score. Male narrator with confident, engaging delivery reading each text slide.
Text: SUPER BOLD, extra large, white, thick font weight, centered, high contrast against dark backgrounds.
Do NOT show real people's faces. Use abstract visuals, motion graphics, silhouettes.`;
}

export const SEEDANCE_ASPECT_RATIOS = ["21:9", "16:9", "9:16", "4:3", "3:4", "1:1"] as const;
export const SEEDANCE_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
