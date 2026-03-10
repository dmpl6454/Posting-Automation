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

  const body = {
    contents: [{
      parts: [{ text: params.prompt }]
    }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: {
        aspectRatio: params.aspectRatio || "1:1",
        imageSize: params.imageSize || "1K",
      },
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Nano Banana API error (${response.status}): ${error}`);
  }

  const data = await response.json();
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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Nano Banana edit API error (${response.status}): ${error}`);
  }

  const data = await response.json();
  return parseNanoBananaResponse(data);
}

/**
 * Parse the Gemini API response to extract image data
 */
function parseNanoBananaResponse(data: any): NanoBananaResult {
  const candidate = data.candidates?.[0];
  if (!candidate?.content?.parts) {
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
    throw new Error("No image data in Nano Banana response");
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
