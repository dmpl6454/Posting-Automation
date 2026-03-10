import { ChatAnthropic } from "@langchain/anthropic";

export function getAnthropicModel(temperature = 0.7) {
  return new ChatAnthropic({
    modelName: "claude-sonnet-4-20250514",
    temperature,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  });
}
