import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AIProvider } from "../types";
import { getOpenAIModel } from "./openai.provider";
import { getAnthropicModel } from "./anthropic.provider";

/**
 * Get a LangChain-compatible model for OpenAI or Anthropic.
 * For Gemini, use callGemini() directly from gemini.provider.ts.
 */
export function getModel(provider: AIProvider, temperature = 0.7): BaseChatModel {
  switch (provider) {
    case "openai":
      return getOpenAIModel(temperature);
    case "anthropic":
      return getAnthropicModel(temperature);
    case "gemini":
      throw new Error("Gemini does not use LangChain. Use callGemini() directly.");
    default:
      throw new Error(`Unknown AI provider: ${provider}`);
  }
}

export function isLangChainProvider(provider: AIProvider): provider is "openai" | "anthropic" {
  return provider === "openai" || provider === "anthropic";
}
