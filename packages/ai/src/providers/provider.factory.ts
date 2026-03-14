import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AIProvider } from "../types";
import { getOpenAIModel } from "./openai.provider";
import { getAnthropicModel } from "./anthropic.provider";
import { getGrokModel } from "./grok.provider";

/**
 * Get a LangChain-compatible model for OpenAI, Anthropic, or Grok.
 * For Gemini, use callGemini() directly from gemini.provider.ts.
 * For Manus, use callManus() directly from manus.provider.ts.
 */
export function getModel(provider: AIProvider, temperature = 0.7): BaseChatModel {
  switch (provider) {
    case "openai":
      return getOpenAIModel(temperature);
    case "anthropic":
      return getAnthropicModel(temperature);
    case "grok":
      return getGrokModel(temperature);
    case "gemini":
      throw new Error("Gemini does not use LangChain. Use callGemini() directly.");
    case "manus":
      throw new Error("Manus does not use LangChain. Use callManus() directly.");
    default:
      throw new Error(`Unknown AI provider: ${provider}`);
  }
}

/**
 * LangChain providers can use prompt templates, chains, and streaming natively.
 * Grok uses the OpenAI-compatible API via LangChain's ChatOpenAI.
 */
export function isLangChainProvider(provider: AIProvider): provider is "openai" | "anthropic" | "grok" {
  return provider === "openai" || provider === "anthropic" || provider === "grok";
}
