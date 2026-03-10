import { StringOutputParser } from "@langchain/core/output_parsers";
import { getModel } from "../providers/provider.factory";
import { contentGenerationPrompt } from "../prompts/content.prompts";
import { PLATFORM_CHAR_LIMITS, PLATFORM_TONES } from "../prompts/platform-specific.prompts";
import type { ContentGenerationParams } from "../types";

export async function generateContent(params: ContentGenerationParams): Promise<string> {
  const model = getModel(params.provider);
  const chain = contentGenerationPrompt.pipe(model).pipe(new StringOutputParser());

  const charLimit = params.charLimit || PLATFORM_CHAR_LIMITS[params.platform] || 280;
  const tone = params.tone || PLATFORM_TONES[params.platform] || "professional";

  return chain.invoke({
    platform: params.platform,
    charLimit: charLimit.toString(),
    tone,
    userPrompt: params.userPrompt,
  });
}
