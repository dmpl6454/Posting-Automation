/**
 * AI Video Generation Provider via fal.ai
 * Default: Seedance 2.0 text-to-video (early access)
 * Fallback: WAN 2.7 text-to-video (GA) via FAL_VIDEO_MODEL env
 *
 * Queue flow:
 * 1. POST to https://queue.fal.run/{model} → get request_id
 * 2. GET  status → poll until COMPLETED
 * 3. GET  result → get video URL
 * 4. Download video bytes
 */

const FAL_QUEUE_BASE = "https://queue.fal.run";

// fal.ai model endpoint IDs. Seedance 2.0 is published under the BARE
// `bytedance/...` namespace — NOT `fal-ai/bytedance/...`. The old
// `fal-ai/bytedance/seedance-2.0/text-to-video` ID does not exist: the queue
// accepted the submit but instant-"COMPLETED" it with 0.027s inference, empty
// logs, and a 404 result ("Path /seedance-2.0/text-to-video not found") — i.e.
// it silently never generated. Verified live: the corrected ID runs real
// inference (~3 min) and returns a video URL.
const MODELS = {
  seedance2: "bytedance/seedance-2.0/text-to-video",
  seedance2Fast: "bytedance/seedance-2.0/fast/text-to-video",
  wan27: "fal-ai/wan/v2.7/text-to-video",
} as const;

function getModelId(): string {
  return process.env.FAL_VIDEO_MODEL || MODELS.seedance2;
}

export interface SeedanceGenerateParams {
  prompt: string;
  /** Duration in seconds (2-12, default: 5) */
  duration?: number;
  /** Aspect ratio (default: "9:16" for reels) */
  aspectRatio?: "16:9" | "9:16" | "4:3" | "3:4" | "1:1" | "auto";
  /** Resolution (default: "720p") */
  resolution?: "480p" | "720p" | "1080p";
  /** Seed for reproducibility */
  seed?: number;
  /** Negative prompt */
  negativePrompt?: string;
  /** Generate audio (Seedance 2.0 only) */
  generateAudio?: boolean;
  /** Optional callback fired on each poll so callers can surface live progress. */
  onProgress?: (p: { elapsedSeconds: number; status: string }) => void;
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

/** Safely parse JSON from a fetch response, with HTML detection */
async function safeJsonParse(res: Response, label: string): Promise<any> {
  const text = await res.text();
  if (text.startsWith("<") || text.startsWith("<!")) {
    throw new Error(`${label} returned HTML instead of JSON: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON: ${text.slice(0, 300)}`);
  }
}

/**
 * Generate a video using fal.ai
 */
export async function generateSeedanceVideo(params: SeedanceGenerateParams): Promise<SeedanceResult> {
  const apiKey = getApiKey();
  const modelId = getModelId();
  const isSeedance = modelId.includes("seedance");

  const submitUrl = `${FAL_QUEUE_BASE}/${modelId}`;
  const duration = String(Math.max(2, Math.min(12, params.duration || 5)));

  // Build input payload
  const input: Record<string, unknown> = {
    prompt: params.prompt,
    aspect_ratio: params.aspectRatio || "9:16",
    duration,
    resolution: params.resolution || "720p",
  };

  if (isSeedance) {
    // Seedance 2.0 specific params
    input.generate_audio = params.generateAudio !== false;
  } else {
    // WAN 2.7 specific params
    input.enable_prompt_expansion = true;
  }

  if (params.negativePrompt) {
    input.negative_prompt = params.negativePrompt;
  }
  if (params.seed !== undefined) {
    input.seed = params.seed;
  }

  console.log(`[VideoGen] Submitting to ${modelId}: "${params.prompt.slice(0, 80)}..." (${duration}s, ${input.aspect_ratio})`);

  // Step 1: Submit to queue
  const submitRes = await fetch(submitUrl, {
    method: "POST",
    headers: {
      "Authorization": `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text();
    throw new Error(`Video submit failed (${submitRes.status}): ${errText.slice(0, 500)}`);
  }

  const submitData = await safeJsonParse(submitRes, "Video submit");
  const requestId = submitData.request_id;

  if (!requestId) {
    throw new Error(`No request_id returned: ${JSON.stringify(submitData).slice(0, 500)}`);
  }

  // CRITICAL: use the canonical status_url / response_url that fal.ai returns
  // in the submit response — do NOT reconstruct the path from `modelId`.
  // fal.ai's queue API uses the APP PREFIX for status/result (e.g.
  // `fal-ai/bytedance/requests/{id}/status`), NOT the full model path
  // (`fal-ai/bytedance/seedance-2.0/text-to-video/...`). Rebuilding it from
  // modelId produced HTTP 405 on every poll → 7.5-min "perpetual generating"
  // timeout. The submit response carries the correct URLs; trust them.
  const statusUrl: string =
    submitData.status_url || `${FAL_QUEUE_BASE}/${modelId}/requests/${requestId}/status`;
  const responseUrl: string =
    submitData.response_url || `${FAL_QUEUE_BASE}/${modelId}/requests/${requestId}`;

  console.log(`[VideoGen] Request submitted: ${requestId} (status: ${statusUrl})`);

  // Step 2: Poll until completed
  const MAX_POLLS = 90;
  const POLL_INTERVAL = 5000;
  let completed = false;
  let consecutivePollErrors = 0;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));

    try {
      const statusRes = await fetch(statusUrl, {
        headers: { "Authorization": `Key ${apiKey}` },
      });

      if (!statusRes.ok) {
        consecutivePollErrors++;
        console.warn(`[VideoGen] Status poll ${i}: HTTP ${statusRes.status} (${consecutivePollErrors} in a row)`);
        // Fail fast on a persistent client-side error (e.g. 401/403/404/405):
        // these never self-resolve, so polling 90× is pointless. A 5xx /
        // transient error is allowed to retry.
        if (statusRes.status < 500 && consecutivePollErrors >= 3) {
          const body = await statusRes.text().catch(() => "");
          throw new Error(
            `Video status check failed (HTTP ${statusRes.status}). The video provider rejected the status request. ${body.slice(0, 200)}`,
          );
        }
        continue;
      }
      consecutivePollErrors = 0;

      const statusData = await safeJsonParse(statusRes, "Status poll");

      if (statusData.status === "COMPLETED") {
        console.log(`[VideoGen] Completed after ${((i + 1) * POLL_INTERVAL) / 1000}s`);
        completed = true;
        break;
      }

      if (statusData.status === "FAILED") {
        throw new Error(`Video generation failed: ${statusData.error || JSON.stringify(statusData)}`);
      }

      // Surface progress on every poll so the UI/logs never look frozen.
      const elapsed = Math.round(((i + 1) * POLL_INTERVAL) / 1000);
      if (params.onProgress) {
        params.onProgress({ elapsedSeconds: elapsed, status: statusData.status || "IN_QUEUE" });
      }
      if (i % 4 === 0) {
        console.log(`[VideoGen] Generating... (${elapsed}s, status: ${statusData.status})`);
      }
    } catch (e) {
      if ((e as Error).message.includes("generation failed") || (e as Error).message.includes("status check failed")) throw e;
      console.warn(`[VideoGen] Poll error: ${(e as Error).message}`);
      continue;
    }
  }

  if (!completed) {
    throw new Error("Video generation timed out after 7.5 minutes");
  }

  // Step 3: Fetch result
  const resultUrl = responseUrl;
  const resultRes = await fetch(resultUrl, {
    headers: { "Authorization": `Key ${apiKey}` },
  });

  if (!resultRes.ok) {
    const errText = await resultRes.text();
    throw new Error(`Result fetch failed (${resultRes.status}): ${errText.slice(0, 500)}`);
  }

  const resultData = await safeJsonParse(resultRes, "Result fetch");
  const videoUrl = resultData.video?.url;

  if (!videoUrl) {
    console.error(`[VideoGen] No video URL: ${JSON.stringify(resultData).slice(0, 1000)}`);
    throw new Error("No video URL in result");
  }

  console.log(`[VideoGen] Video ready: ${videoUrl}`);

  // Step 4: Download video
  const downloadRes = await fetch(videoUrl);
  if (!downloadRes.ok) {
    throw new Error(`Video download failed: HTTP ${downloadRes.status}`);
  }

  const videoBuf = Buffer.from(await downloadRes.arrayBuffer());
  console.log(`[VideoGen] Downloaded: ${(videoBuf.length / 1024 / 1024).toFixed(1)}MB`);

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
You may show generic, anonymous people, crowds, and silhouettes. Do NOT depict any specific, real, named public figure or attempt to recreate a real person's likeness.`;
}

export const SEEDANCE_ASPECT_RATIOS = ["16:9", "9:16", "4:3", "3:4", "1:1", "auto"] as const;
export const SEEDANCE_DURATIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
