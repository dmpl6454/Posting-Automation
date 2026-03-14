import type { AIProvider } from "../types";
import { callGemini } from "../providers/gemini.provider";

export interface RouterContext {
  threadHistory?: Array<{ role: string; content: string }>;
  hasAttachments?: boolean;
  agentNiche?: string;
  lastProvider?: AIProvider;
}

interface RoutingRule {
  keywords: string[];
  provider: AIProvider;
}

/**
 * Routing rules checked in priority order.
 * A message must match 2+ keywords from a single rule to trigger it.
 * If keywords from multiple rules match, we skip rules and use LLM fallback.
 */
export const ROUTING_RULES: RoutingRule[] = [
  {
    keywords: ["trending", "breaking", "news", "viral", "what's happening", "headlines"],
    provider: "grok",
  },
  {
    keywords: ["imagine", "creative", "story", "write me", "brainstorm", "poem", "narrative"],
    provider: "anthropic",
  },
  {
    keywords: ["analyze", "compare", "data", "statistics", "research", "summarize", "explain"],
    provider: "deepseek",
  },
  {
    keywords: ["schedule", "plan", "optimize", "format", "json", "list", "steps", "organize"],
    provider: "openai",
  },
  {
    keywords: ["image", "photo", "design", "visual", "picture", "graphic", "diagram"],
    provider: "gemini",
  },
];

const NICHE_PROVIDER_MAP: Record<string, AIProvider> = {
  news: "grok",
  trending: "grok",
  creative: "anthropic",
  writing: "anthropic",
  storytelling: "anthropic",
  analytics: "deepseek",
  research: "deepseek",
  data: "deepseek",
  scheduling: "openai",
  productivity: "openai",
  design: "gemini",
  visual: "gemini",
};

const CATEGORY_TO_PROVIDER: Record<string, AIProvider> = {
  trending: "grok",
  creative: "anthropic",
  analytical: "deepseek",
  structured: "openai",
  visual: "gemini",
};

const DEFAULT_PROVIDER: AIProvider = "openai";

function countKeywordMatches(message: string, keywords: string[]): number {
  const lower = message.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw.toLowerCase())).length;
}

function getKeywordMatches(
  message: string
): Array<{ provider: AIProvider; count: number }> {
  const matched: Array<{ provider: AIProvider; count: number }> = [];
  for (const rule of ROUTING_RULES) {
    const count = countKeywordMatches(message, rule.keywords);
    if (count >= 2) {
      matched.push({ provider: rule.provider, count });
    }
  }
  return matched;
}

async function classifyWithLLM(message: string): Promise<AIProvider | null> {
  const prompt = `Classify this social media message into one category:
- trending (real-time news/events)
- creative (storytelling, copywriting)
- analytical (data, comparison, research)
- structured (scheduling, formatting, planning)
- visual (images, design, multimodal)

Message: ${message}

Reply with ONLY the category name.`;

  try {
    const result = await Promise.race([
      callGemini(prompt, { temperature: 0, maxTokens: 20 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Router classification timeout")), 2000)
      ),
    ]);

    const category = result.trim().toLowerCase();
    return CATEGORY_TO_PROVIDER[category] ?? null;
  } catch {
    return null;
  }
}

/**
 * Route a user message to the best AI provider.
 *
 * Priority (per spec):
 * 1. Attachments → gemini
 * 2. Thread continuity (sticky provider) — unless strong keyword signal overrides
 * 3. Keyword rules (single-category match with 2+ keywords)
 * 4. Agent niche mapping
 * 5. LLM fallback (Gemini Flash classification)
 * 6. Default: openai
 */
export async function routeProvider(
  message: string,
  context: RouterContext
): Promise<AIProvider> {
  if (context.hasAttachments) {
    return "gemini";
  }

  const matchedRules = getKeywordMatches(message);

  if (context.lastProvider) {
    if (matchedRules.length === 1) {
      return matchedRules[0]!.provider;
    }
    if (matchedRules.length > 1) {
      const llmResult = await classifyWithLLM(message);
      return llmResult ?? context.lastProvider;
    }
    return context.lastProvider;
  }

  if (matchedRules.length === 1) {
    return matchedRules[0]!.provider;
  }
  if (matchedRules.length > 1) {
    const llmResult = await classifyWithLLM(message);
    return llmResult ?? DEFAULT_PROVIDER;
  }

  if (context.agentNiche) {
    const nicheProvider = NICHE_PROVIDER_MAP[context.agentNiche.toLowerCase()];
    if (nicheProvider) {
      return nicheProvider;
    }
  }

  const llmResult = await classifyWithLLM(message);
  return llmResult ?? DEFAULT_PROVIDER;
}
