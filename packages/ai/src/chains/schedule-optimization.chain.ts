import { StringOutputParser } from "@langchain/core/output_parsers";
import { getModel } from "../providers/provider.factory";
import { contentOptimizationPrompt } from "../prompts/content.prompts";
import type { OptimizeParams } from "../types";

export async function optimizeContent(params: OptimizeParams): Promise<string> {
  const model = getModel(params.provider || "openai");
  const chain = contentOptimizationPrompt.pipe(model).pipe(new StringOutputParser());

  return chain.invoke({
    content: params.content,
    platform: params.platform,
    goal: params.goal,
  });
}
