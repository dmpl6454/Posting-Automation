import { ChatAnthropic } from "@langchain/anthropic";

// Default to claude-sonnet-4-6 (current, non-deprecated alias — no date suffix).
// Operators can override via ANTHROPIC_MODEL without a code change if Anthropic
// rotates model IDs again. (Mirrors the OPENAI_MODEL override in openai.provider.ts.)
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

export function getAnthropicModel(temperature = 0.7) {
  return new ChatAnthropic({
    modelName: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
    temperature,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  });
}
