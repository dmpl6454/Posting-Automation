/**
 * OpenAI DALL-E 3 image generation provider
 * Uses the OpenAI Images API for text-to-image generation
 * Note: DALL-E 3 does not support image editing — edit requests
 *       will generate a new image inspired by the edit prompt instead.
 */

const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";

export interface DallEGenerateParams {
  prompt: string;
  size?: "1024x1024" | "1024x1792" | "1792x1024";
  quality?: "standard" | "hd";
}

export interface DallEResult {
  imageBase64: string;
  mimeType: string;
  text?: string; // Revised prompt returned by DALL-E 3
}

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY environment variable is required for DALL-E image generation"
    );
  }
  return key;
}

/**
 * Generate an image from a text prompt using DALL-E 3
 */
export async function generateImageDallE(
  params: DallEGenerateParams
): Promise<DallEResult> {
  const apiKey = getApiKey();

  const body = {
    model: "dall-e-3",
    prompt: params.prompt,
    n: 1,
    size: params.size || "1024x1024",
    quality: params.quality || "standard",
    response_format: "b64_json",
  };

  const response = await fetch(OPENAI_IMAGES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`DALL-E API error (${response.status}): ${error}`);
  }

  const data = (await response.json()) as DallEAPIResponse;

  const firstImage = data.data[0];
  if (!firstImage?.b64_json) {
    throw new Error("No image data in DALL-E response");
  }

  return {
    imageBase64: firstImage.b64_json,
    mimeType: "image/png",
    text: firstImage.revised_prompt,
  };
}

/**
 * DALL-E 3 does not support direct image editing.
 * This function generates a new image inspired by the edit prompt instead.
 * The original image is NOT used — only the text prompt is sent to DALL-E 3.
 */
export async function editImageDallE(params: {
  prompt: string;
  imageBase64: string;
  imageMimeType?: string;
}): Promise<DallEResult> {
  const result = await generateImageDallE({
    prompt: params.prompt,
    size: "1024x1024",
    quality: "standard",
  });

  return {
    ...result,
    text:
      "Note: DALL-E 3 does not support direct image editing. A new image was generated based on your prompt instead. " +
      (result.text || ""),
  };
}

// Available sizes for DALL-E 3
export const DALLE_SIZES = [
  "1024x1024",
  "1024x1792",
  "1792x1024",
] as const;

// Available quality options
export const DALLE_QUALITIES = ["standard", "hd"] as const;

// --- Internal API response types ---

interface DallEAPIResponseItem {
  b64_json?: string;
  revised_prompt?: string;
}

interface DallEAPIResponse {
  data: DallEAPIResponseItem[];
}
