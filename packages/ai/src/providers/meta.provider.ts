/**
 * Meta AI image generation provider
 * Uses Together AI (Meta's official inference partner) with FLUX.1-schnell-Free model
 * Env: TOGETHER_API_KEY
 */

const TOGETHER_IMAGES_URL = "https://api.together.xyz/v1/images/generations";

// Meta AI uses FLUX.1 via Together AI (Meta's strategic AI inference partner)
const META_IMAGE_MODEL = "black-forest-labs/FLUX.1-schnell-Free";

export interface MetaGenerateParams {
  prompt: string;
  aspectRatio?: string; // "1:1" | "16:9" | "9:16" | "4:3" | "3:4"
}

export interface MetaImageResult {
  imageBase64: string;
  mimeType: string;
}

function getApiKey(): string {
  const key = process.env.TOGETHER_API_KEY;
  if (!key) throw new Error("TOGETHER_API_KEY environment variable is required for Meta AI image generation");
  return key;
}

function aspectRatioToDimensions(ratio: string): { width: number; height: number } {
  const map: Record<string, { width: number; height: number }> = {
    "1:1":  { width: 1024, height: 1024 },
    "16:9": { width: 1344, height: 768 },
    "9:16": { width: 768,  height: 1344 },
    "4:3":  { width: 1152, height: 896 },
    "3:4":  { width: 896,  height: 1152 },
  };
  return map[ratio] ?? { width: 1024, height: 1024 };
}

export async function generateImageMeta(params: MetaGenerateParams): Promise<MetaImageResult> {
  const apiKey = getApiKey();
  const { width, height } = aspectRatioToDimensions(params.aspectRatio ?? "1:1");

  const response = await fetch(TOGETHER_IMAGES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: META_IMAGE_MODEL,
      prompt: params.prompt,
      width,
      height,
      n: 1,
      response_format: "base64",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Meta AI error (${response.status}): ${error}`);
  }

  const data = (await response.json()) as { data: Array<{ b64_json?: string }> };
  const image = data.data?.[0];

  if (!image?.b64_json) throw new Error("No image data in Meta AI response");

  return {
    imageBase64: image.b64_json,
    mimeType: "image/png",
  };
}
