/**
 * Google Nano Banana 2 image generation provider
 * Uses the Gemini API for text-to-image and image editing
 * Model: gemini-3.1-flash-image-preview (Nano Banana 2)
 */

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface NanoBananaGenerateParams {
  prompt: string;
  aspectRatio?: string; // "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | etc.
  imageSize?: string;   // "512" | "1K" | "2K" | "4K"
  model?: string;       // defaults to gemini-3.1-flash-image-preview
  referenceImages?: Array<{ base64: string; mimeType?: string }>; // reference/logo images
}

interface NanoBananaEditParams {
  prompt: string;
  imageBase64: string;
  imageMimeType?: string; // defaults to "image/jpeg"
  model?: string;
}

interface NanoBananaResult {
  imageBase64: string;
  mimeType: string;
  text?: string; // Optional text response
}

/**
 * Fetch with retry for rate-limit (429) and server errors (500/503)
 * Retries up to 3 times with exponential backoff
 */
async function fetchWithRetry(url: string, init: RequestInit, label = "generate"): Promise<any> {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, init);

    if (response.ok) {
      return response.json();
    }

    const errorText = await response.text();

    // Retry on rate-limit or server errors
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30000); // 2s, 4s, 8s...
      console.warn(`[Nano Banana] ${label} got ${response.status}, retrying in ${delay / 1000}s (attempt ${attempt}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    throw new Error(`Nano Banana API error (${response.status}): ${errorText}`);
  }
  throw new Error("Nano Banana API: max retries exceeded");
}

function getApiKey(): string {
  const key = process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
  if (!key) {
    throw new Error("GOOGLE_GEMINI_API_KEY or GOOGLE_AI_API_KEY environment variable is required for Nano Banana image generation");
  }
  return key;
}

/**
 * Generate an image from a text prompt using Nano Banana 2
 */
export async function generateImage(params: NanoBananaGenerateParams): Promise<NanoBananaResult> {
  const apiKey = getApiKey();
  const model = params.model || "gemini-3.1-flash-image-preview";

  const url = `${GEMINI_API_BASE}/models/${model}:generateContent`;

  // Build parts: text prompt + any reference images (design references, logos, etc.)
  const parts: any[] = [{ text: params.prompt }];
  if (params.referenceImages && params.referenceImages.length > 0) {
    for (const ref of params.referenceImages) {
      parts.push({
        inline_data: {
          mime_type: ref.mimeType || "image/jpeg",
          data: ref.base64,
        },
      });
    }
  }

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: {
        aspectRatio: params.aspectRatio || "1:1",
        imageSize: params.imageSize || "1K",
      },
    },
  };

  const data = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  return parseNanoBananaResponse(data);
}

/**
 * Edit an existing image using Nano Banana 2
 * Provide a base64 image and a text prompt describing the edits
 */
export async function editImage(params: NanoBananaEditParams): Promise<NanoBananaResult> {
  const apiKey = getApiKey();
  const model = params.model || "gemini-3.1-flash-image-preview";

  const url = `${GEMINI_API_BASE}/models/${model}:generateContent`;

  const body = {
    contents: [{
      parts: [
        { text: params.prompt },
        {
          inline_data: {
            mime_type: params.imageMimeType || "image/jpeg",
            data: params.imageBase64,
          },
        },
      ],
    }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  };

  const data = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  }, "edit");

  return parseNanoBananaResponse(data);
}

/**
 * Parse the Gemini API response to extract image data
 */
function parseNanoBananaResponse(data: any): NanoBananaResult {
  const candidate = data.candidates?.[0];

  // Check for safety block or finish reason issues
  if (candidate?.finishReason && candidate.finishReason !== "STOP") {
    throw new Error(`Image generation blocked: ${candidate.finishReason}. Try a different prompt.`);
  }

  if (!candidate?.content?.parts) {
    const reason = data.promptFeedback?.blockReason;
    if (reason) throw new Error(`Prompt blocked by safety filter: ${reason}. Try rephrasing.`);
    throw new Error("No content in Nano Banana response");
  }

  let imageBase64 = "";
  let mimeType = "image/png";
  let text = "";

  for (const part of candidate.content.parts) {
    if (part.inlineData) {
      imageBase64 = part.inlineData.data;
      mimeType = part.inlineData.mimeType || "image/png";
    }
    if (part.text) {
      text = part.text;
    }
  }

  if (!imageBase64) {
    const hint = text ? ` Model responded with text: "${text.slice(0, 100)}"` : "";
    throw new Error(`No image data in Nano Banana response.${hint} Try a different prompt or model.`);
  }

  return { imageBase64, mimeType, text };
}

// Available aspect ratios for Nano Banana
export const NANO_BANANA_ASPECT_RATIOS = [
  "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9",
] as const;

// Available image sizes
export const NANO_BANANA_SIZES = ["512", "1K", "2K", "4K"] as const;

// Available models
export const NANO_BANANA_MODELS = {
  NANO_BANANA_2: "gemini-3.1-flash-image-preview",     // Fast, high-quality
  NANO_BANANA_PRO: "gemini-3-pro-image-preview",       // Professional quality
  NANO_BANANA: "gemini-2.5-flash-image",                // Classic
} as const;

export type { NanoBananaGenerateParams, NanoBananaEditParams, NanoBananaResult };
