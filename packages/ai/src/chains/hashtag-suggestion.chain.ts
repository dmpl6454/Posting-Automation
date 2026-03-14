import { StringOutputParser } from "@langchain/core/output_parsers";
import { getModel, isLangChainProvider } from "../providers/provider.factory";
import { callGemini } from "../providers/gemini.provider";
import { callManus } from "../providers/manus.provider";
import { hashtagSuggestionPrompt } from "../prompts/content.prompts";
import type { HashtagParams } from "../types";

export async function suggestHashtags(params: HashtagParams): Promise<string[]> {
  const provider = params.provider || "openai";
  let result: string;

  if (isLangChainProvider(provider)) {
    const model = getModel(provider);
    const chain = hashtagSuggestionPrompt.pipe(model).pipe(new StringOutputParser());
    result = await chain.invoke({
      content: params.content,
      platform: params.platform,
    });
  } else {
    const prompt = `You are a social media hashtag expert. Suggest relevant hashtags for the given content on ${params.platform}.
Return only the hashtags separated by spaces, no explanations. Include a mix of popular and niche hashtags.
Return 5-10 hashtags.

Content: ${params.content}`;
    result = provider === "manus" ? await callManus(prompt) : await callGemini(prompt);
  }

  return result
    .split(/\s+/)
    .filter((tag) => tag.startsWith("#"))
    .map((tag) => tag.trim());
}
