/**
 * AI Video Generation Provider via fal.ai
 * Uses WAN 2.7 text-to-video (generally available)
 * Fallback-ready for Seedance 2.0 when access is granted
 *
 * Flow:
 * 1. POST to queue → get request_id
 * 2. Poll status until COMPLETED
 * 3. Fetch result → get video URL (response.video.url)
 * 4. Download video bytes
 */

const FAL_QUEUE_BASE = "https://queue.fal.run";

// WAN 2.7 is GA; Seedance 2.0 requires early access approval
const MODELS = {
  wan27: "fal-ai/wan/v2.7/text-to-video",
  seedance2: "fal-ai/bytedance/seedance-2.0/text-to-video",
} as const;

// Use env override or default to WAN 2.7
function getModelId(): string {
  return process.env.FAL_VIDEO_MODEL || MODELS.wan27;
}

export interface SeedanceGenerateParams {
  prompt: string;
  /** Duration in seconds (2-15, default: 5) */
  duration?: number;
  /** Aspect ratio (default: "9:16" for reels) */
  aspectRatio?: "16:9" | "9:16" | "4:3" | "3:4" | "1:1";
  /** Resolution (default: "720p") */
  resolution?: "720p" | "1080p";
  /** Seed for reproducibility */
  seed?: number;
  /** Negative prompt */
  negativePrompt?: string;
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
    throw new Error("FAL_KEY is required for AI video generation");
  }
  return key;
}

/**
 * Generate a video using fal.ai (WAN 2.7 or Seedance 2.0)
 */
export async function generateSeedanceVideo(params: SeedanceGenerateParams): Promise<SeedanceResult> {
  const apiKey = getApiKey();
  const modelId = getModelId();

  // Step 1: Submit to queue
  const submitUrl = `${FAL_QUEUE_BASE}/${modelId}`;

  const duration = String(Math.max(2, Math.min(15, params.duration || 5)));

  const body: Record<string, unknown> = {
    prompt: params.prompt,
    aspect_ratio: params.aspectRatio || "9:16",
    duration,
    resolution: params.resolution || "720p",
    enable_prompt_expansion: true,
  };

  if (params.negativePrompt) {
    body.negative_prompt = params.negativePrompt;
  }

  if (params.seed !== undefined) {
    body.seed = params.seed;
  }

  console.log(`[VideoGen] Submitting to ${modelId}: "${params.prompt.slice(0, 80)}..." (${duration}s, ${body.aspect_ratio})`);

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
    throw new Error(`Video submit failed (${submitRes.status}): ${errText}`);
  }

  // Handle HTML error responses (CDN/proxy errors)
  const submitContentType = submitRes.headers.get("content-type") || "";
  if (!submitContentType.includes("application/json")) {
    const text = await submitRes.text();
    throw new Error(`Video API returned non-JSON response (${submitContentType}): ${text.slice(0, 200)}`);
  }

  const submitData = await submitRes.json();
  const requestId = submitData.request_id;

  if (!requestId) {
    throw new Error(`Video API did not return a request_id: ${JSON.stringify(submitData).slice(0, 500)}`);
  }

  console.log(`[VideoGen] Request submitted: ${requestId}`);

  // Step 2: Poll until completed (video gen takes 30s-5min)
  const MAX_POLLS = 90; // 7.5 min max
  const POLL_INTERVAL = 5000; // 5s
  let completed = false;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));

    const statusUrl = `${FAL_QUEUE_BASE}/${modelId}/requests/${requestId}/status`;
    const statusRes = await fetch(statusUrl, {
      headers: { "Authorization": `Key ${apiKey}` },
    });

    if (!statusRes.ok) {
      console.warn(`[VideoGen] Status poll failed (${statusRes.status})`);
      continue;
    }

    const statusContentType = statusRes.headers.get("content-type") || "";
    if (!statusContentType.includes("application/json")) {
      console.warn(`[VideoGen] Status poll returned non-JSON, retrying...`);
      continue;
    }

    const statusData = await statusRes.json();

    if (statusData.status === "COMPLETED") {
      console.log(`[VideoGen] Generation completed after ${((i + 1) * POLL_INTERVAL) / 1000}s`);
      completed = true;
      break;
    }

    if (statusData.status === "FAILED") {
      throw new Error(`Video generation failed: ${statusData.error || "Unknown error"}`);
    }

    // Log progress every 30s
    if (i % 6 === 0) {
      const elapsed = ((i + 1) * POLL_INTERVAL) / 1000;
      console.log(`[VideoGen] Still generating... (${elapsed}s, status: ${statusData.status})`);
    }
  }

  if (!completed) {
    throw new Error("Video generation timed out after 7.5 minutes");
  }

  // Step 3: Fetch result
  const resultUrl = `${FAL_QUEUE_BASE}/${modelId}/requests/${requestId}`;
  const resultRes = await fetch(resultUrl, {
    headers: { "Authorization": `Key ${apiKey}` },
  });

  if (!resultRes.ok) {
    const errText = await resultRes.text();
    throw new Error(`Video result fetch failed (${resultRes.status}): ${errText}`);
  }

  const resultData = await resultRes.json();

  // Response format: { video: { url: "..." }, seed: 42 }
  const videoUrl = resultData.video?.url;

  if (!videoUrl) {
    console.error(`[VideoGen] No video URL in result: ${JSON.stringify(resultData).slice(0, 1000)}`);
    throw new Error("Video API returned no video URL");
  }

  console.log(`[VideoGen] Video ready: ${videoUrl}`);

  // Step 4: Download video
  const downloadRes = await fetch(videoUrl);
  if (!downloadRes.ok) {
    throw new Error(`Video download failed: ${downloadRes.status}`);
  }

  const videoBuf = Buffer.from(await downloadRes.arrayBuffer());
  console.log(`[VideoGen] Downloaded video: ${(videoBuf.length / 1024 / 1024).toFixed(1)}MB`);

  return {
    videoBase64: videoBuf.toString("base64"),
    mimeType: "video/mp4",
    durationSeconds: parseInt(duration),
    videoUrl,
    seed: resultData.seed,
  };
}

/**
 * Build a video-optimized prompt
 */
export function buildSeedancePrompt(opts: {
  title: string;
  keyPoints: string[];
  visualStyle?: string;
  musicMood?: string;
  brandName?: string;
}): string {
  const style = opts.visualStyle || "cinematic, professional, modern";

  const scenes = opts.keyPoints
    .map((point, i) => `Scene ${i + 2}: Bold white text "${point}" centered on screen over dramatic cinematic B-roll.`)
    .join("\n");

  return `Create a VERTICAL 9:16 social media video with bold text overlays and cinematic visuals.

Style: ${style}

Scene 1: Opening — enormous bold white title "${opts.title}" zooms in with dramatic camera push. Dark cinematic background.
${scenes}
Final scene: Call-to-action "${opts.brandName || "Follow for More"}" with dynamic typography animation.

Camera: Smooth dolly movements, subtle parallax, cinematic rack focus transitions between scenes.
Text: SUPER BOLD, extra large, white, thick font weight, centered, high contrast against dark backgrounds.
Do NOT show real people's faces. Use abstract visuals, motion graphics, silhouettes.`;
}

export const SEEDANCE_ASPECT_RATIOS = ["16:9", "9:16", "4:3", "3:4", "1:1"] as const;
export const SEEDANCE_DURATIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
