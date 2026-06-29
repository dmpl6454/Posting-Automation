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
    // ⚠️ @langchain/anthropic@0.3.34 uses topP=-1 as an internal "unset"
    // sentinel and only strips it for model names containing opus-4-1 /
    // sonnet-4-5 / haiku-4-5. claude-sonnet-4-6 matches NONE of those, so the
    // ctor's else-branch (`this.topP = fields?.topP ?? this.topP` = -1) leaks a
    // literal top_p:-1 onto the wire → Anthropic 400 "top_p cannot be set to -1
    // for this model". This surfaces whenever the [chosen→openai→anthropic]
    // text-fallback chain reaches the anthropic hop (e.g. OpenAI out of credits).
    // Pass an explicit valid value (matches ChatOpenAI's own topP default of 1).
    // topP: undefined / null do NOT work — both collapse back to -1 via `?? -1`.
    topP: 1,
  });
}
