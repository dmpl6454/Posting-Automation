import { StringOutputParser } from "@langchain/core/output_parsers";
import { getModel, isLangChainProvider } from "../providers/provider.factory";
import { callGemini } from "../providers/gemini.provider";
import { callGemma4 } from "../providers/gemma4.provider";
import { contentGenerationPrompt } from "../prompts/content.prompts";
import { PLATFORM_CHAR_LIMITS, PLATFORM_TONES } from "../prompts/platform-specific.prompts";
import { detectGroundingNeed, searchForGrounding, buildGroundingContext } from "../utils/web-grounding";
import type { ContentGenerationParams } from "../types";

export async function generateContent(params: ContentGenerationParams): Promise<string> {
  const charLimit = params.charLimit || PLATFORM_CHAR_LIMITS[params.platform] || 280;
  const tone = params.tone || PLATFORM_TONES[params.platform] || "professional";

  const needsGrounding = !!detectGroundingNeed(params.userPrompt);

  // For LangChain providers, use Google News RSS grounding as fallback
  let groundingContext = "";
  if (needsGrounding && isLangChainProvider(params.provider)) {
    const groundingQueries = detectGroundingNeed(params.userPrompt);
    if (groundingQueries) {
      console.log(`[AI] LangChain provider — using RSS grounding for: ${groundingQueries.join(", ")}`);
      try {
        const groundingResults = await searchForGrounding(groundingQueries);
        groundingContext = buildGroundingContext(groundingResults);
        if (groundingContext) {
          console.log(`[AI] Grounding found ${groundingResults.filter(r => r.grounded).length} results`);
        }
      } catch (e) {
        console.warn(`[AI] Grounding search failed:`, (e as Error).message);
      }
    }
  }

  // LangChain providers: OpenAI, Anthropic, Grok, DeepSeek
  if (isLangChainProvider(params.provider)) {
    const groundedPrompt = groundingContext
      ? `${params.userPrompt}${groundingContext}`
      : params.userPrompt;

    const model = getModel(params.provider);
    const chain = contentGenerationPrompt.pipe(model).pipe(new StringOutputParser());
    return chain.invoke({
      platform: params.platform,
      charLimit: charLimit.toString(),
      tone,
      userPrompt: groundedPrompt,
    });
  }

  // Non-LangChain providers: Gemini / Gemma4
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
- IMPORTANT: Do NOT make up facts, statistics, names, dates, or events. If the user mentions specific people, movies, products, or events, keep them exactly as stated. Never fabricate lists, rankings, or data. If asked to enhance existing content, preserve ALL original facts unchanged.
- When Google Search results are available, use ONLY verified data from those results. Do not add items not found in the search results.

User request: ${params.userPrompt}`;

  if (params.provider === "gemma4") {
    return callGemma4(prompt);
  }

  // Gemini — use native Google Search grounding
  if (needsGrounding) {
    console.log(`[AI] Gemini provider — using native Google Search grounding`);
  }
  return callGemini(prompt, { grounded: needsGrounding });
}
