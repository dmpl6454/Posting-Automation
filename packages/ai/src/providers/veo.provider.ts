/**
 * Google Veo 3 Video Generation Provider
 * Uses the Gemini API predictLongRunning endpoint
 * Model: veo-3.0-generate-001
 *
 * Flow:
 * 1. POST predictLongRunning → get operation name
 * 2. Poll operation until done → get video file URI
 * 3. Download video bytes from Files API
 */

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface VeoGenerateParams {
  prompt: string;
  /** Reference image (base64) to guide visual style */
  referenceImage?: { base64: string; mimeType?: string };
  /** Duration in seconds: 5 or 8 (default: 8) */
  durationSeconds?: number;
  /** Aspect ratio: "16:9" | "9:16" (default: "9:16" for reels) */
  aspectRatio?: string;
  /** Number of videos to generate (1-4, default: 1) */
  sampleCount?: number;
  /** Enable enhanced prompt rewriting (default: true) */
  enhancePrompt?: boolean;
  /** Negative prompt — what to avoid */
  negativePrompt?: string;
  /** Person generation: "dont_allow" | "allow_adult" (default: "allow_adult") */
  personGeneration?: "dont_allow" | "allow_adult";
}

export interface VeoResult {
  videoBase64: string;
  mimeType: string;
  durationSeconds: number;
}

function getApiKey(): string {
  const key = process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  if (!key) {
    throw new Error("GOOGLE_GEMINI_API_KEY is required for Veo video generation");
  }
  return key;
}

/**
 * Generate a video using Google Veo 3
 */
export async function generateVideo(params: VeoGenerateParams): Promise<VeoResult> {
  const apiKey = getApiKey();
  const model = "veo-3.0-generate-001";

  // Step 1: Submit generation request via predictLongRunning
  const url = `${GEMINI_API_BASE}/models/${model}:predictLongRunning?key=${apiKey}`;

  const instances: any[] = [{ prompt: params.prompt }];

  // Add reference image if provided
  if (params.referenceImage) {
    instances[0].image = {
      bytesBase64Encoded: params.referenceImage.base64,
      mimeType: params.referenceImage.mimeType || "image/jpeg",
    };
  }

  const body = {
    instances,
    parameters: {
      aspectRatio: params.aspectRatio || "9:16",
      sampleCount: params.sampleCount || 1,
      durationSeconds: params.durationSeconds || 8,
      personGeneration: params.personGeneration || "allow_adult",
      ...(params.negativePrompt ? { negativePrompt: params.negativePrompt } : {}),
    },
  };

  console.log(`[Veo3] Submitting video generation: "${params.prompt.slice(0, 80)}..."`);

  const submitRes = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!submitRes.ok) {
    const errText = await submitRes.text();
    throw new Error(`Veo3 submit failed (${submitRes.status}): ${errText}`);
  }

  const submitData: any = await submitRes.json();
  const operationName = submitData.name;

  if (!operationName) {
    throw new Error("Veo3 did not return an operation name");
  }

  console.log(`[Veo3] Operation started: ${operationName}`);

  // Step 2: Poll until operation is done (video gen takes 1-3 min)
  const MAX_POLLS = 60; // 5 min max
  const POLL_INTERVAL = 5000; // 5s

  let videoFileName: string | null = null;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));

    const pollUrl = `${GEMINI_API_BASE}/${operationName}?key=${apiKey}`;
    const pollRes = await fetch(pollUrl);

    if (!pollRes.ok) {
      const errText = await pollRes.text();
      console.warn(`[Veo3] Poll failed (${pollRes.status}): ${errText}`);
      continue;
    }

    const pollData: any = await pollRes.json();
    console.log(`[Veo3] Poll ${i + 1} response: ${JSON.stringify(pollData).slice(0, 500)}`);

    if (pollData.done) {
      if (pollData.error) {
        throw new Error(`Veo3 generation failed: ${JSON.stringify(pollData.error)}`);
      }

      // Try all known response formats
      const resp = pollData.response || pollData;

      // Check for RAI (safety) content filter
      const videoResp = resp?.generateVideoResponse;
      if (videoResp?.raiMediaFilteredCount > 0) {
        const reasons = videoResp.raiMediaFilteredReasons?.join("; ") || "Content policy violation";
        throw new Error(`Veo3 content filtered: ${reasons}`);
      }

      // Format 1: generateVideoResponse.generatedSamples
      const samples = videoResp?.generatedSamples
        || resp?.generatedSamples
        || [];
      if (samples.length > 0) {
        const sample = samples[0];
        videoFileName = sample.video?.uri || sample.videoUri || null;
      }

      // Format 2: predictions array
      if (!videoFileName) {
        const predictions = resp?.predictions || [];
        if (predictions.length > 0) {
          videoFileName = predictions[0].videoUri || predictions[0].video?.uri || null;
        }
      }

      // Format 3: direct videos array
      if (!videoFileName) {
        const videos = resp?.videos || [];
        if (videos.length > 0) {
          videoFileName = videos[0].uri || videos[0].name || null;
        }
      }

      if (!videoFileName) {
        console.error(`[Veo3] No video URI in response: ${JSON.stringify(pollData).slice(0, 1000)}`);
      }

      break;
    }

    // Log progress every 30s
    if (i % 6 === 0) {
      const elapsed = ((i + 1) * POLL_INTERVAL) / 1000;
      console.log(`[Veo3] Still generating... (${elapsed}s elapsed)`);
    }
  }

  if (!videoFileName) {
    throw new Error("Veo3 video generation timed out or returned no video");
  }

  console.log(`[Veo3] Video ready: ${videoFileName}`);

  // Step 3: Download video bytes from Files API
  // Append API key to the video URI using correct query separator
  const appendKey = (u: string) => {
    if (u.includes("key=")) return u;
    const sep = u.includes("?") ? "&" : "?";
    return `${u}${sep}key=${apiKey}`;
  };

  let downloadUrl: string;
  if (videoFileName.startsWith("http")) {
    // Full URL — just append key
    downloadUrl = appendKey(videoFileName);
    // Ensure alt=media is present for binary download
    if (!downloadUrl.includes("alt=media")) downloadUrl += "&alt=media";
  } else {
    // Relative path like "files/xxx"
    downloadUrl = `${GEMINI_API_BASE}/${videoFileName}?key=${apiKey}&alt=media`;
  }

  console.log(`[Veo3] Downloading from: ${downloadUrl.replace(apiKey, "KEY")}`);

  const downloadRes = await fetch(downloadUrl);
  if (!downloadRes.ok) {
    const errText = await downloadRes.text().catch(() => "");
    console.error(`[Veo3] Download failed (${downloadRes.status}): ${errText.slice(0, 300)}`);
    throw new Error(`Veo3 download failed: ${downloadRes.status}`);
  }

  const videoBuf = Buffer.from(await downloadRes.arrayBuffer());
  console.log(`[Veo3] Downloaded video: ${(videoBuf.length / 1024 / 1024).toFixed(1)}MB`);

  return {
    videoBase64: videoBuf.toString("base64"),
    mimeType: "video/mp4",
    durationSeconds: params.durationSeconds || 8,
  };
}

/**
 * Build a cinematic video prompt from content
 * Combines text slides with visual descriptions and music cues
 */
export function buildVideoPrompt(opts: {
  title: string;
  keyPoints: string[];
  visualStyle?: string;
  musicMood?: string;
  brandName?: string;
}): string {
  const style = opts.visualStyle || "cinematic, professional, modern design";
  const music = opts.musicMood || "upbeat corporate, subtle electronic";

  // Strip any real person names/celebrity references to avoid Veo safety filter
  const sanitize = (text: string) =>
    text.replace(/\b(Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.)\s+[A-Z][a-z]+/g, "a person")
        .replace(/[A-Z][a-z]+ [A-Z][a-z]{2,}(?:'s)?/g, (match) => {
          const safe = ["Follow for", "Breaking News", "Key Points", "Social Media", "New York", "Los Angeles", "San Francisco", "United States", "Wall Street"];
          return safe.some(s => match.startsWith(s)) ? match : "a professional";
        });

  const safeTitle = sanitize(opts.title);
  const safeSlides = opts.keyPoints
    .map((point, i) => `Scene ${i + 2}: SUPER BOLD white text "${sanitize(point)}" fills the center of screen — extra large, thick font, high contrast against dark cinematic B-roll background. A narrator voice reads the text aloud.`)
    .join("\n");

  return `Create a VERTICAL 9:16 portrait social media video in the style of viral Instagram Reels and TikTok videos.

FORMAT: 9:16 VERTICAL (phone screen, portrait mode — taller than wide)
STYLE: ${style}
MUSIC: ${music}

Scene 1: SUPER BOLD white title text "${safeTitle}" — enormous thick font centered on screen, dramatic zoom-in animation. Dark cinematic background. A narrator voice introduces the topic.
${safeSlides}
Scene ${opts.keyPoints.length + 2}: Closing card with BOLD text "${opts.brandName || "Follow for More"}" — call-to-action with subscribe/follow prompt. Narrator says "Follow for more."

CRITICAL REQUIREMENTS:
- VERTICAL 9:16 portrait orientation (like a phone screen)
- TEXT must be SUPER BOLD, EXTRA LARGE, white or bright colored, thick heavy font weight
- Text must be centered and fill most of the screen width
- Text must have high contrast (dark/blurred background behind bright text)
- Include a male narrator voiceover reading each text slide aloud in an engaging, confident tone
- Cinematic B-roll backgrounds behind every text overlay (motion graphics, stock footage, abstract visuals)
- Smooth zoom and slide transitions between scenes
- Dramatic cinematic color grading (dark tones, high contrast)
- Background music: ${music}
- Do NOT show any real person's face or likeness — use abstract visuals, silhouettes, graphics only
- Style reference: viral news/fact Instagram Reels with bold text overlays and voiceover narration`;
}

export const VEO_MODELS = {
  VEO_2: "veo-2.0-generate-001",
  VEO_3: "veo-3.0-generate-001",
  VEO_3_FAST: "veo-3.0-fast-generate-001",
} as const;

export const VEO_ASPECT_RATIOS = ["16:9", "9:16"] as const;
export const VEO_DURATIONS = [5, 8] as const;
