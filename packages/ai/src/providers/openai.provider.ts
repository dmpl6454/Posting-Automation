import { ChatOpenAI } from "@langchain/openai";

// Default to gpt-4o (current, non-deprecated). Operators can override via
// OPENAI_MODEL without a code change if OpenAI rotates model IDs again.
const DEFAULT_OPENAI_MODEL = "gpt-4o";

export function getOpenAIModel(temperature = 0.7) {
  return new ChatOpenAI({
    modelName: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
    temperature,
    openAIApiKey: process.env.OPENAI_API_KEY,
  });
}
