import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { getModel } from "../providers/provider.factory";
import { PLATFORM_CHAR_LIMITS, PLATFORM_TONES } from "../prompts/platform-specific.prompts";
import type { AIProvider } from "../types";

const repurposePrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are an expert social media content strategist. Your job is to repurpose long-form content into platform-specific social media posts.

For each target platform, create a post that:
- Respects the platform's character limit
- Uses the appropriate tone and style for that platform
- Captures the key message from the original content
- Is optimized for engagement on that specific platform
- Includes relevant hashtags if appropriate for the platform

You MUST respond in the following JSON format exactly:
{{
  "PLATFORM_NAME": "generated content for that platform",
  "ANOTHER_PLATFORM": "generated content for that platform"
}}

Return ONLY the JSON object, no additional text or markdown formatting.`,
  ],
  [
    "human",
    `Repurpose the following content for these platforms: {platforms}

Platform details:
{platformDetails}

Original content:
{originalContent}`,
  ],
]);

export interface RepurposeParams {
  originalContent: string;
  targetPlatforms: string[];
  provider: AIProvider;
}

export async function repurposeContent(
  params: RepurposeParams
): Promise<Record<string, string>> {
  const { originalContent, targetPlatforms, provider } = params;

  const model = getModel(provider);
  const chain = repurposePrompt.pipe(model).pipe(new StringOutputParser());

  // Build platform details string
  const platformDetails = targetPlatforms
    .map((platform) => {
      const charLimit = PLATFORM_CHAR_LIMITS[platform] || 280;
      const tone = PLATFORM_TONES[platform] || "professional";
      return `- ${platform}: max ${charLimit} characters, tone: ${tone}`;
    })
    .join("\n");

  const response = await chain.invoke({
    platforms: targetPlatforms.join(", "),
    platformDetails,
    originalContent: originalContent.slice(0, 8000), // Limit input size
  });

  // Parse the JSON response
  try {
    // Strip markdown code fences if present
    const cleaned = response
      .replace(/```json\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    const parsed = JSON.parse(cleaned) as Record<string, string>;
    return parsed;
  } catch {
    // If JSON parsing fails, try to extract content for each platform
    const result: Record<string, string> = {};
    for (const platform of targetPlatforms) {
      const regex = new RegExp(
        `"${platform}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`,
        "i"
      );
      const match = response.match(regex);
      if (match) {
        result[platform] = (match[1] ?? "").replace(/\\n/g, "\n").replace(/\\"/g, '"');
      } else {
        result[platform] = `[Content generation failed for ${platform}]`;
      }
    }
    return result;
  }
}
