import { StringOutputParser } from "@langchain/core/output_parsers";
import { getModel, isLangChainProvider } from "../providers/provider.factory";
import { callGemini } from "../providers/gemini.provider";
import { callGemma4 } from "../providers/gemma4.provider";
import { contentOptimizationPrompt } from "../prompts/content.prompts";
import type { OptimizeParams } from "../types";

export async function optimizeContent(params: OptimizeParams): Promise<string> {
  const provider = params.provider || "openai";

  if (isLangChainProvider(provider)) {
    const model = getModel(provider);
    const chain = contentOptimizationPrompt.pipe(model).pipe(new StringOutputParser());
    return chain.invoke({
      content: params.content,
      platform: params.platform,
      goal: params.goal,
    });
  }

  const prompt = `You are a social media optimization expert. Rewrite the given content to optimize for ${params.goal} on ${params.platform}.
Keep the core message but improve it for the specified goal.
Return only the optimized content, no explanations.

Original content: ${params.content}`;

  return provider === "gemma4" ? callGemma4(prompt) : callGemini(prompt);
}
