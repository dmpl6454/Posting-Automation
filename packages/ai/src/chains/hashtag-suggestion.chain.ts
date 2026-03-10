import { StringOutputParser } from "@langchain/core/output_parsers";
import { getModel } from "../providers/provider.factory";
import { hashtagSuggestionPrompt } from "../prompts/content.prompts";
import type { HashtagParams } from "../types";

export async function suggestHashtags(params: HashtagParams): Promise<string[]> {
  const model = getModel(params.provider || "openai");
  const chain = hashtagSuggestionPrompt.pipe(model).pipe(new StringOutputParser());

  const result = await chain.invoke({
    content: params.content,
    platform: params.platform,
  });

  return result
    .split(/\s+/)
    .filter((tag) => tag.startsWith("#"))
    .map((tag) => tag.trim());
}
