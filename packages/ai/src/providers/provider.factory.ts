import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AIProvider } from "../types";
import { getOpenAIModel } from "./openai.provider";
import { getAnthropicModel } from "./anthropic.provider";

export function getModel(provider: AIProvider, temperature = 0.7): BaseChatModel {
  switch (provider) {
    case "openai":
      return getOpenAIModel(temperature);
    case "anthropic":
      return getAnthropicModel(temperature);
    default:
      throw new Error(`Unknown AI provider: ${provider}`);
  }
}
