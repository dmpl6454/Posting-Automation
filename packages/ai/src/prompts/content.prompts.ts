import { ChatPromptTemplate } from "@langchain/core/prompts";

export const contentGenerationPrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a social media content expert writing posts for {platform}.
CRITICAL: Output ONLY the post text and hashtags. Nothing else.
- Do NOT include any preamble like "Here's a post..." or "Here's an engaging..."
- Do NOT explain what you wrote or add commentary
- Start directly with the post content
- Character limit: {charLimit}
- Tone: {tone}
- Include relevant hashtags if appropriate for the platform
- Optimize for engagement on this specific platform
- Be creative and authentic
- Do not use generic filler phrases`,
  ],
  ["human", "{userPrompt}"],
]);

export const hashtagSuggestionPrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a social media hashtag expert. Suggest relevant hashtags for the given content on {platform}.
Return only the hashtags separated by spaces, no explanations. Include a mix of popular and niche hashtags.
Return 5-10 hashtags.`,
  ],
  ["human", "Content: {content}"],
]);

export const contentOptimizationPrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a social media optimization expert. Rewrite the given content to optimize for {goal} on {platform}.
Keep the core message but improve it for the specified goal.
Return only the optimized content, no explanations.`,
  ],
  ["human", "Original content: {content}"],
]);
