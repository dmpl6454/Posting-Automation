import { ChatOpenAI } from "@langchain/openai";

/**
 * DeepSeek provider — uses the OpenAI-compatible API at api.deepseek.com.
 * Model: deepseek-chat (DeepSeek-V3)
 * Env: DEEPSEEK_API_KEY
 */
export function getDeepSeekModel(temperature = 0.7) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "DeepSeek API key not found. Set DEEPSEEK_API_KEY in your environment."
    );
  }

  return new ChatOpenAI({
    modelName: "deepseek-chat",
    temperature,
    openAIApiKey: apiKey,
    configuration: {
      baseURL: "https://api.deepseek.com",
    },
  });
}
