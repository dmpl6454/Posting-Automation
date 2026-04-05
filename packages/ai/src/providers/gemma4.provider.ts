/**
 * Google Gemma 4 Provider
 * Uses the Google Generative AI SDK with gemma-3-27b-it model
 * (served via Gemini API — same SDK as gemini.provider.ts)
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

const MODEL_NAME = "gemma-3-27b-it";

let clientInstance: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!clientInstance) {
    const apiKey =
      process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Google API key not found. Set GOOGLE_GEMINI_API_KEY or GOOGLE_AI_API_KEY."
      );
    }
    clientInstance = new GoogleGenerativeAI(apiKey);
  }
  return clientInstance;
}

/**
 * Call Gemma 4 for text generation via the Gemini API.
 * Gemma models don't support Google Search grounding — text-only.
 */
export async function callGemma4(
  prompt: string,
  options: { temperature?: number; maxTokens?: number } = {}
): Promise<string> {
  const client = getClient();

  const model = client.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens ?? 4096,
    },
  });

  const result = await model.generateContent(prompt);
  const response = result.response;
  return response.text();
}
