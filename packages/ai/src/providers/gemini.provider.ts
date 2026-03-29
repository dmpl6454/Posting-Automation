import { GoogleGenerativeAI, DynamicRetrievalMode } from "@google/generative-ai";
import type { Tool } from "@google/generative-ai";

const MODEL_NAME = "gemini-2.5-flash";

let clientInstance: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!clientInstance) {
    const apiKey =
      process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Google Gemini API key not found. Set GOOGLE_GEMINI_API_KEY or GOOGLE_AI_API_KEY."
      );
    }
    clientInstance = new GoogleGenerativeAI(apiKey);
  }
  return clientInstance;
}

/**
 * Call Gemini for text generation, returning the text response.
 * Designed to be a drop-in alternative alongside LangChain OpenAI/Anthropic providers.
 */
export async function callGemini(
  prompt: string,
  options: { temperature?: number; maxTokens?: number; grounded?: boolean } = {}
): Promise<string> {
  const client = getClient();

  const tools: Tool[] = [];
  if (options.grounded) {
    tools.push({
      googleSearchRetrieval: {
        dynamicRetrievalConfig: {
          mode: DynamicRetrievalMode.MODE_DYNAMIC,
          dynamicThreshold: 0.3,
        },
      },
    });
  }

  const model = client.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens ?? 4096,
    },
    ...(tools.length > 0 ? { tools } : {}),
  });

  const result = await model.generateContent(prompt);
  const response = result.response;
  return response.text();
}
