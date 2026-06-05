/**
 * OpenAI image generation provider.
 *
 * Uses the OpenAI Images API (`gpt-image-1`) for text-to-image generation.
 * Historically this called `dall-e-3`, but the production OpenAI account has
 * NO access to the `dall-e-*` family (the API returns 400 "model does not
 * exist") — only the `gpt-image-*` family. The old model also made the
 * `safe-image-generator` fallback a dead path: when Gemini 403'd on a billing
 * hold, the fallback hit `dall-e-3`, 400'd, and re-threw the original Gemini
 * error. Switching to `gpt-image-1` (verified live) re-arms the fallback so
 * images generate via OpenAI even while Google billing is suspended.
 *
 * Note: `gpt-image-1` always returns base64 (`b64_json`); it does NOT accept a
 * `response_format` param (sending it returns 400 "Unknown parameter").
 */

const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";

/** OpenAI image model. `gpt-image-1` is the model this account has access to. */
const OPENAI_IMAGE_MODEL = "gpt-image-1";

/**
 * Sizes accepted by callers. The legacy DALL-E-3 values (`1024x1792`,
 * `1792x1024`) are still accepted at the type level (the public image API and
 * older callers pass them) and normalized to the nearest `gpt-image-1` size.
 */
export type DallESize =
  | "1024x1024"
  | "1024x1536"
  | "1536x1024"
  | "auto"
  // legacy DALL-E-3 aliases (normalized below)
  | "1024x1792"
  | "1792x1024";

/** Quality accepted by callers; legacy `standard`/`hd` are normalized. */
export type DallEQuality = "low" | "medium" | "high" | "auto" | "standard" | "hd";

export interface DallEGenerateParams {
  prompt: string;
  size?: DallESize;
  quality?: DallEQuality;
}

export interface DallEResult {
  imageBase64: string;
  mimeType: string;
  text?: string; // Revised prompt (when the model returns one)
}

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY environment variable is required for OpenAI image generation"
    );
  }
  return key;
}

/** Map any caller-supplied size to a value `gpt-image-1` actually accepts. */
function normalizeSize(size?: DallESize): "1024x1024" | "1024x1536" | "1536x1024" | "auto" {
  switch (size) {
    case "1024x1792": // legacy portrait → gpt-image-1 portrait
      return "1024x1536";
    case "1792x1024": // legacy landscape → gpt-image-1 landscape
      return "1536x1024";
    case "1024x1024":
    case "1024x1536":
    case "1536x1024":
    case "auto":
      return size;
    default:
      return "1024x1024";
  }
}

/** Map any caller-supplied quality to a `gpt-image-1` value. */
function normalizeQuality(quality?: DallEQuality): "low" | "medium" | "high" | "auto" {
  switch (quality) {
    case "standard": // legacy
      return "medium";
    case "hd": // legacy
      return "high";
    case "low":
    case "medium":
    case "high":
    case "auto":
      return quality;
    default:
      return "high";
  }
}

/**
 * Generate an image from a text prompt using DALL-E 3
 */
export async function generateImageDallE(
  params: DallEGenerateParams
): Promise<DallEResult> {
  const apiKey = getApiKey();

  const body = {
    model: OPENAI_IMAGE_MODEL,
    prompt: params.prompt,
    n: 1,
    size: normalizeSize(params.size),
    quality: normalizeQuality(params.quality),
    // NOTE: gpt-image-1 returns b64_json by default and REJECTS a
    // `response_format` param (400 "Unknown parameter"). Do not re-add it.
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
 * This image model does not support direct image editing.
 * This function generates a new image inspired by the edit prompt instead.
 * The original image is NOT used — only the text prompt is sent.
 */
export async function editImageDallE(params: {
  prompt: string;
  imageBase64: string;
  imageMimeType?: string;
}): Promise<DallEResult> {
  const result = await generateImageDallE({
    prompt: params.prompt,
    size: "1024x1024",
    quality: "high",
  });

  return {
    ...result,
    text:
      "Note: this image model does not support direct image editing. A new image was generated based on your prompt instead. " +
      (result.text || ""),
  };
}

// Available sizes for gpt-image-1
export const DALLE_SIZES = [
  "1024x1024",
  "1024x1536",
  "1536x1024",
] as const;

// Available quality options for gpt-image-1
export const DALLE_QUALITIES = ["low", "medium", "high", "auto"] as const;

// --- Internal API response types ---

interface DallEAPIResponseItem {
  b64_json?: string;
  revised_prompt?: string;
}

interface DallEAPIResponse {
  data: DallEAPIResponseItem[];
}
