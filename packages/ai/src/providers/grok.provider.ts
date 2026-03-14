import { ChatOpenAI } from "@langchain/openai";

/**
 * Grok (xAI) provider — uses the OpenAI-compatible API at api.x.ai.
 * Model: grok-3
 * Env: XAI_API_KEY
 */
export function getGrokModel(temperature = 0.7) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "xAI API key not found. Set XAI_API_KEY in your environment."
    );
  }

  return new ChatOpenAI({
    modelName: "grok-3",
    temperature,
    openAIApiKey: apiKey,
    configuration: {
      baseURL: "https://api.x.ai/v1",
    },
  });
}
