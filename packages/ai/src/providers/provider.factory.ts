import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AIProvider } from "../types";
import { getOpenAIModel } from "./openai.provider";
import { getAnthropicModel } from "./anthropic.provider";
import { getGrokModel } from "./grok.provider";
import { getDeepSeekModel } from "./deepseek.provider";

/**
 * Get a LangChain-compatible model for OpenAI, Anthropic, Grok, or DeepSeek.
 * For Gemini, use callGemini() directly from gemini.provider.ts.
 */
export function getModel(provider: AIProvider, temperature = 0.7): BaseChatModel {
  switch (provider) {
    case "openai":
      return getOpenAIModel(temperature);
    case "anthropic":
      return getAnthropicModel(temperature);
    case "grok":
      return getGrokModel(temperature);
    case "deepseek":
      return getDeepSeekModel(temperature);
    case "gemini":
      throw new Error("Gemini does not use LangChain. Use callGemini() directly.");
    case "gemma4":
      throw new Error("Gemma 4 does not use LangChain. Use callGemma4() directly.");
    default:
      throw new Error(`Unknown AI provider: ${provider}`);
  }
}

/**
 * LangChain providers can use prompt templates, chains, and streaming natively.
 * Grok and DeepSeek use OpenAI-compatible APIs via LangChain's ChatOpenAI.
 */
export function isLangChainProvider(provider: AIProvider): provider is "openai" | "anthropic" | "grok" | "deepseek" {
  return provider === "openai" || provider === "anthropic" || provider === "grok" || provider === "deepseek";
}

/** Providers that use the Google Generative AI SDK (not LangChain) */
export function isGoogleNativeProvider(provider: AIProvider): provider is "gemini" | "gemma4" {
  return provider === "gemini" || provider === "gemma4";
}
