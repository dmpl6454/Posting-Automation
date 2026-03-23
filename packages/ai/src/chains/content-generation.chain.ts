import { StringOutputParser } from "@langchain/core/output_parsers";
import { getModel, isLangChainProvider } from "../providers/provider.factory";
import { callGemini } from "../providers/gemini.provider";
import { contentGenerationPrompt } from "../prompts/content.prompts";
import { PLATFORM_CHAR_LIMITS, PLATFORM_TONES } from "../prompts/platform-specific.prompts";
import type { ContentGenerationParams } from "../types";

export async function generateContent(params: ContentGenerationParams): Promise<string> {
  const charLimit = params.charLimit || PLATFORM_CHAR_LIMITS[params.platform] || 280;
  const tone = params.tone || PLATFORM_TONES[params.platform] || "professional";

  // LangChain providers: OpenAI, Anthropic, Grok, DeepSeek
  if (isLangChainProvider(params.provider)) {
    const model = getModel(params.provider);
    const chain = contentGenerationPrompt.pipe(model).pipe(new StringOutputParser());
    return chain.invoke({
      platform: params.platform,
      charLimit: charLimit.toString(),
      tone,
      userPrompt: params.userPrompt,
    });
  }

  // Non-LangChain providers: Gemini
  const prompt = `You are a social media content expert writing posts for ${params.platform}.
CRITICAL: Output ONLY the post text and hashtags. Nothing else.
- Do NOT include any preamble like "Here's a post..." or "Here's an engaging..."
- Do NOT explain what you wrote or add commentary
- Start directly with the post content
- Character limit: ${charLimit}
- Tone: ${tone}
- Include relevant hashtags if appropriate for the platform
- Optimize for engagement on this specific platform
- Be creative and authentic
- Do not use generic filler phrases

User request: ${params.userPrompt}`;

  return callGemini(prompt);
}
