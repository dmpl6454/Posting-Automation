/**
 * describeImageStyle — provider-agnostic aesthetic-reference describer.
 *
 * The aesthetic/style-reference feature only conditioned the AI background via
 * Gemini (Nano Banana). With Gemini on a billing hold (403), generation falls
 * back to `gpt-image-1`, which has NO image-input path — so the reference was a
 * silent no-op in production.
 *
 * Fix: send the reference image ONCE to an OpenAI vision model and get a short
 * (~40-word) STYLE descriptor (palette/lighting/composition/mood/medium — never
 * the subject/people/text). That descriptor is appended to the image prompt, so
 * even the text-only `gpt-image-1` path mimics the reference style. The raw
 * image is ALSO still pushed into `referenceImages` so Gemini conditioning
 * resumes automatically once billing returns.
 *
 * Uses `ChatOpenAI` (the same `@langchain/openai` SDK + `OPENAI_API_KEY` env
 * that `openai.provider.ts` uses) with `gpt-4o-mini` — vision-capable and cheap.
 * Returns `null` on ANY failure (no key, SDK throw, empty content) so the caller
 * never blocks generation on a missing/failed descriptor.
 */

import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";

const STYLE_PROMPT =
  "Describe ONLY this image's visual style in 40 words or fewer: color palette, lighting, composition, mood, and medium (photo/illustration/3D). Do NOT describe the subject, people, or any text. Reply with the description only.";

// Vision-capable, cheap. Operators can override via OPENAI_VISION_MODEL.
const VISION_MODEL = "gpt-4o-mini";

const MAX_DESCRIPTOR_CHARS = 300;

/**
 * Returns a short style descriptor for an image, or null on any failure.
 * Provider-agnostic: uses OpenAI vision so it works while Gemini is billing-held.
 */
export async function describeImageStyle(
  base64: string,
  mimeType: string,
): Promise<string | null> {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;

    const model = new ChatOpenAI({
      modelName: process.env.OPENAI_VISION_MODEL || VISION_MODEL,
      temperature: 0,
      maxTokens: 80,
      openAIApiKey: apiKey,
    });

    const message = new HumanMessage({
      content: [
        { type: "text", text: STYLE_PROMPT },
        {
          type: "image_url",
          image_url: { url: `data:${mimeType};base64,${base64}` },
        },
      ],
    });

    const res = await model.invoke([message]);
    const raw = res?.content;
    const text =
      typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? raw
              .map((p) =>
                p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "",
              )
              .join(" ")
          : "";
    const trimmed = text.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, MAX_DESCRIPTOR_CHARS);
  } catch {
    return null;
  }
}
