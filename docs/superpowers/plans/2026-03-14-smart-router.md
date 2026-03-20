# Smart Router Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically route each chat message to the best AI provider (OpenAI, Anthropic, Gemini, Grok, DeepSeek) based on content/context, replacing static provider selection.

**Architecture:** A `routeProvider()` function in `packages/ai/src/routing/smart-router.ts` uses keyword rules (first pass) and a Gemini Flash LLM classifier (fallback) to select the optimal provider. The chat stream route calls this function when no explicit provider is specified. Thread continuity (sticky provider) prevents jarring mid-conversation provider switches.

**Tech Stack:** TypeScript, Vitest, `@google/generative-ai` (Gemini Flash for classification), existing LangChain provider infrastructure.

**Spec:** `docs/superpowers/specs/2026-03-14-smart-router-design.md`

---

## Chunk 1: Smart Router Module

### Task 1: Create routing rules constants and types

**Files:**
- Create: `packages/ai/src/routing/smart-router.ts`

- [ ] **Step 1: Create the routing directory and file with types and constants**

```ts
// packages/ai/src/routing/smart-router.ts
import type { AIProvider } from "../types";

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
```

- [ ] **Step 2: Commit**

```bash
git add packages/ai/src/routing/smart-router.ts
git commit -m "feat: add smart router constants and types"
```

---

### Task 2: Write tests for keyword-based routing

**Files:**
- Create: `packages/ai/src/__tests__/smart-router.test.ts`

- [ ] **Step 1: Write failing tests for keyword matching logic**

```ts
// packages/ai/src/__tests__/smart-router.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock callGemini so no real API calls are made
vi.mock("../providers/gemini.provider", () => ({
  callGemini: vi.fn(),
}));

import { routeProvider, ROUTING_RULES } from "../routing/smart-router";
import { callGemini } from "../providers/gemini.provider";
import type { AIProvider } from "../types";

const mockedCallGemini = vi.mocked(callGemini);

describe("Smart Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("keyword routing", () => {
    it("should route trending/news messages to grok", async () => {
      const result = await routeProvider("What's the latest trending news today?", {});
      expect(result).toBe("grok");
    });

    it("should route creative writing messages to anthropic", async () => {
      const result = await routeProvider("Write me a creative story about space exploration", {});
      expect(result).toBe("anthropic");
    });

    it("should route analytical messages to deepseek", async () => {
      const result = await routeProvider("Analyze and compare the data from our campaigns", {});
      expect(result).toBe("deepseek");
    });

    it("should route structured/planning messages to openai", async () => {
      const result = await routeProvider("Schedule and plan my content for next week", {});
      expect(result).toBe("openai");
    });

    it("should route visual/image messages to gemini", async () => {
      const result = await routeProvider("Create a visual design for our image post", {});
      expect(result).toBe("gemini");
    });

    it("should route to gemini when hasAttachments is true", async () => {
      const result = await routeProvider("Check this out", { hasAttachments: true });
      expect(result).toBe("gemini");
    });
  });

  describe("keyword overlap (compound queries)", () => {
    it("should fall through to LLM when keywords match multiple categories", async () => {
      mockedCallGemini.mockResolvedValueOnce("analytical");
      // 2+ keywords in both grok ("trending", "breaking", "news") and deepseek ("analyze", "research", "data")
      const result = await routeProvider(
        "Analyze and research the breaking trending news data",
        {}
      );
      expect(mockedCallGemini).toHaveBeenCalled();
      expect(result).toBe("deepseek"); // LLM returned "analytical"
    });
  });

  describe("thread continuity (sticky provider)", () => {
    it("should prefer lastProvider when no strong keyword signal", async () => {
      const result = await routeProvider("sounds good, go ahead", {
        lastProvider: "anthropic",
      });
      // No keywords match — should stick with last provider
      expect(result).toBe("anthropic");
      expect(mockedCallGemini).not.toHaveBeenCalled();
    });

    it("should override sticky provider when strong single-category keyword signal exists", async () => {
      const result = await routeProvider("Now analyze and summarize the research data", {
        lastProvider: "grok",
      });
      // Strong keyword match (3 keywords) for deepseek overrides sticky
      expect(result).toBe("deepseek");
    });

    it("should use LLM when sticky provider set and multiple keyword categories match", async () => {
      mockedCallGemini.mockResolvedValueOnce("trending");
      const result = await routeProvider(
        "Analyze and research the breaking trending news data",
        { lastProvider: "openai" }
      );
      expect(mockedCallGemini).toHaveBeenCalled();
      expect(result).toBe("grok"); // LLM returned "trending"
    });
  });

  describe("agent niche mapping", () => {
    it("should use niche when no keyword match and no lastProvider", async () => {
      const result = await routeProvider("help me out", { agentNiche: "news" });
      expect(result).toBe("grok");
      expect(mockedCallGemini).not.toHaveBeenCalled();
    });

    it("should ignore niche when keywords match", async () => {
      const result = await routeProvider("Write me a creative brainstorm", {
        agentNiche: "news",
      });
      expect(result).toBe("anthropic");
    });
  });

  describe("LLM fallback", () => {
    it("should call Gemini Flash when no keyword or niche match", async () => {
      mockedCallGemini.mockResolvedValueOnce("creative");
      const result = await routeProvider("help me with something", {});
      expect(mockedCallGemini).toHaveBeenCalled();
      expect(result).toBe("anthropic"); // "creative" maps to anthropic
    });

    it("should default to openai when LLM returns unknown category", async () => {
      mockedCallGemini.mockResolvedValueOnce("something_random");
      const result = await routeProvider("random message", {});
      expect(result).toBe("openai");
    });

    it("should default to openai when LLM call fails", async () => {
      mockedCallGemini.mockRejectedValueOnce(new Error("API timeout"));
      const result = await routeProvider("random message", {});
      expect(result).toBe("openai");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ai && pnpm vitest run src/__tests__/smart-router.test.ts`
Expected: FAIL — `routeProvider` not exported / not found

- [ ] **Step 3: Commit test file**

```bash
git add packages/ai/src/__tests__/smart-router.test.ts
git commit -m "test: add smart router test suite (red)"
```

---

### Task 3: Implement routeProvider function

**Files:**
- Modify: `packages/ai/src/routing/smart-router.ts`

- [ ] **Step 1: Add the routeProvider function below the constants**

Add the import at the top of `packages/ai/src/routing/smart-router.ts` (after the existing `import type` line), then add the functions below the constants:

```ts
// Add this import at the TOP of the file, after the AIProvider import:
import { callGemini } from "../providers/gemini.provider";

/**
 * Count how many keywords from a rule match in the message.
 */
function countKeywordMatches(message: string, keywords: string[]): number {
  const lower = message.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw.toLowerCase())).length;
}

/**
 * Check keyword matches across all rules. Returns matched rules with counts.
 */
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

/**
 * Classify a message using Gemini Flash as a lightweight LLM classifier.
 * Returns an AIProvider or null if classification fails.
 * Uses Promise.race with a 2-second timeout.
 */
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
  // --- Attachments shortcut ---
  if (context.hasAttachments) {
    return "gemini";
  }

  // --- Keyword matching (computed once, used in multiple branches) ---
  const matchedRules = getKeywordMatches(message);

  // --- Thread continuity (sticky provider) ---
  // Prefer lastProvider UNLESS there is a strong single-category keyword match
  if (context.lastProvider) {
    if (matchedRules.length === 1) {
      // Strong keyword signal overrides sticky provider
      return matchedRules[0]!.provider;
    }
    if (matchedRules.length > 1) {
      // Ambiguous keywords — use LLM to resolve
      const llmResult = await classifyWithLLM(message);
      return llmResult ?? context.lastProvider;
    }
    // No keyword match — stick with last provider
    return context.lastProvider;
  }

  // --- Keyword rules (no sticky provider) ---
  if (matchedRules.length === 1) {
    return matchedRules[0]!.provider;
  }
  if (matchedRules.length > 1) {
    const llmResult = await classifyWithLLM(message);
    return llmResult ?? DEFAULT_PROVIDER;
  }

  // --- Agent niche mapping ---
  if (context.agentNiche) {
    const nicheProvider = NICHE_PROVIDER_MAP[context.agentNiche.toLowerCase()];
    if (nicheProvider) {
      return nicheProvider;
    }
  }

  // --- LLM fallback ---
  const llmResult = await classifyWithLLM(message);
  return llmResult ?? DEFAULT_PROVIDER;
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd packages/ai && pnpm vitest run src/__tests__/smart-router.test.ts`
Expected: All 11 tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/ai/src/routing/smart-router.ts
git commit -m "feat: implement routeProvider with keyword rules + LLM fallback"
```

---

### Task 4: Export routeProvider from package index

**Files:**
- Modify: `packages/ai/src/index.ts` (add export after line 8)

- [ ] **Step 1: Add export**

Add this line to `packages/ai/src/index.ts` after the existing provider exports:

```ts
export { routeProvider, ROUTING_RULES } from "./routing/smart-router";
export type { RouterContext } from "./routing/smart-router";
```

- [ ] **Step 2: Run all AI package tests**

Run: `cd packages/ai && pnpm vitest run`
Expected: All tests PASS (existing + new)

- [ ] **Step 3: Commit**

```bash
git add packages/ai/src/index.ts
git commit -m "feat: export routeProvider from ai package"
```

---

## Chunk 2: Stream Route Integration + Fallback

### Task 5: Write tests for stream route provider selection logic

Since the stream route is a Next.js API route (hard to unit test directly), we'll test the integration indirectly by verifying the smart router works correctly with context objects matching the route's usage pattern.

**Files:**
- Modify: `packages/ai/src/__tests__/smart-router.test.ts`

- [ ] **Step 1: Add integration-style tests**

Append to the existing test file:

```ts
  describe("integration: route-style context", () => {
    it("should handle full context object as stream route would pass", async () => {
      const result = await routeProvider("Write me a creative brainstorm for content", {
        threadHistory: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
        hasAttachments: false,
        agentNiche: undefined,
        lastProvider: undefined,
      });
      expect(result).toBe("anthropic");
    });

    it("should handle empty context gracefully", async () => {
      mockedCallGemini.mockResolvedValueOnce("structured");
      const result = await routeProvider("do something", {});
      expect(result).toBe("openai"); // LLM returns "structured"
    });
  });
```

- [ ] **Step 2: Run tests**

Run: `cd packages/ai && pnpm vitest run src/__tests__/smart-router.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/ai/src/__tests__/smart-router.test.ts
git commit -m "test: add integration context tests for smart router"
```

---

### Task 6: Integrate smart router into stream route

**Files:**
- Modify: `apps/web/app/api/chat/stream/route.ts:2-4,51-56,102-103,110-168`

- [ ] **Step 1: Add import for routeProvider**

At the top of `apps/web/app/api/chat/stream/route.ts`, update line 3 import:

```ts
// Change line 3 from:
import { streamChatAgent, parseActions, cleanResponseText, fetchTrendingNews, detectTrendingIntent } from "@postautomation/ai";

// To:
import { streamChatAgent, parseActions, cleanResponseText, fetchTrendingNews, detectTrendingIntent, routeProvider } from "@postautomation/ai";
```

- [ ] **Step 2: Update DB queries to include metadata and niche**

Modify the `dbMessages` query (line 51-56) to also select `metadata`:

```ts
  const dbMessages = await prisma.chatMessage.findMany({
    where: { threadId: body.threadId },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: { role: true, content: true, metadata: true },
  });
```

Also update the thread query's agent select (line 42) to include `niche`:

```ts
    include: {
      agent: { select: { aiProvider: true, niche: true } },
    },
```

- [ ] **Step 3: Replace static provider selection with smart router**

Replace lines 102-103:

```ts
  const provider: AIProvider =
    body.provider || (thread.agent?.aiProvider as AIProvider) || "anthropic";
```

With:

```ts
  // Provider priority: explicit client request > agent preference > smart router
  let provider: AIProvider;
  if (body.provider) {
    provider = body.provider;
  } else if (thread.agent?.aiProvider) {
    provider = thread.agent.aiProvider as AIProvider;
  } else {
    const lastAssistantMsg = dbMessages
      .filter((m) => m.role === "assistant")
      .pop();
    const lastMeta = lastAssistantMsg?.metadata as Record<string, unknown> | null;
    provider = await routeProvider(
      lastUserMessage?.content ?? "",
      {
        threadHistory: messages.slice(-6),
        hasAttachments: false, // TODO: wire up when attachments are tracked
        agentNiche: thread.agent?.niche || undefined,
        lastProvider: (lastMeta?.provider as AIProvider) ?? undefined,
      }
    );
    console.log(`[Chat] Smart router selected provider: ${provider}`);
  }
```

- [ ] **Step 4: Add provider fallback chain around streaming**

Replace the `streamResponse` function (lines 110-168) with fallback logic:

```ts
  // Ordered by reliability — only the first non-failed provider is tried (max 1 fallback)
  const FALLBACK_PRIORITY: AIProvider[] = ["openai", "anthropic", "grok", "deepseek", "gemini"];

  const streamResponse = async () => {
    let fullResponse = "";
    let usedProvider = provider;

    const attemptStream = async (p: AIProvider): Promise<boolean> => {
      try {
        for await (const chunk of streamChatAgent(p, messages, {
          channels: channels.map((ch) => ({
            id: ch.id,
            name: ch.name || ch.username || "Unknown",
            platform: ch.platform,
          })),
          agents,
          trendingNews,
          orgLogo: org?.logo || undefined,
          orgName: org?.name || undefined,
        })) {
          fullResponse += chunk;
          const data = `data: ${JSON.stringify({ type: "chunk", content: chunk })}\n\n`;
          await writer.write(encoder.encode(data));
        }
        usedProvider = p;
        return true;
      } catch (error: any) {
        // If we already wrote chunks, this is a mid-stream failure — don't retry
        if (fullResponse.length > 0) {
          throw error;
        }
        console.error(`[Chat] Provider ${p} failed pre-stream:`, error.message);
        return false;
      }
    };

    try {
      // Try the routed provider first
      let success = await attemptStream(provider);

      // If pre-stream failure, try fallback chain (max 1 fallback)
      if (!success) {
        const fallback = FALLBACK_PRIORITY.find((p) => p !== provider);
        if (fallback) {
          console.log(`[Chat] Falling back from ${provider} to ${fallback}`);
          success = await attemptStream(fallback);
        }
      }

      if (!success) {
        throw new Error("All providers failed");
      }

      // Parse any actions from the response
      const action = parseActions(fullResponse);
      const displayText = cleanResponseText(fullResponse);

      // Save assistant message to DB (include provider in metadata for thread continuity)
      await prisma.chatMessage.create({
        data: {
          threadId: body.threadId,
          role: "assistant",
          content: displayText,
          metadata: {
            ...(action ? { action } : {}),
            provider: usedProvider,
          },
        },
      });

      // Send completion event with action if present
      const doneData = `data: ${JSON.stringify({
        type: "done",
        action: action || null,
        displayText,
      })}\n\n`;
      await writer.write(encoder.encode(doneData));
    } catch (error: any) {
      const errData = `data: ${JSON.stringify({
        type: "error",
        message: error.message || "Failed to generate response",
      })}\n\n`;
      try {
        await writer.write(encoder.encode(errData));
      } catch {
        // Writer may be closed
      }
    } finally {
      try {
        await writer.close();
      } catch {
        // Already closed
      }
    }
  };
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd /Users/sudhanshu6454/Posting\ Automation && pnpm --filter @postautomation/ai build && pnpm --filter web build`
Expected: No type errors

- [ ] **Step 6: Run all AI tests**

Run: `cd packages/ai && pnpm vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/api/chat/stream/route.ts
git commit -m "feat: integrate smart router into chat stream with provider fallback"
```

---

### Task 7: Final verification and commit

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/sudhanshu6454/Posting\ Automation && pnpm --filter @postautomation/ai test`
Expected: All tests PASS

- [ ] **Step 2: Start dev server and test manually**

Run: `cd /Users/sudhanshu6454/Posting\ Automation && pnpm dev`

Manual test cases in the chat:
1. "What's the latest trending news?" → should use Grok
2. "Write me a creative story about AI" → should use Anthropic
3. "Analyze our engagement data" → should use DeepSeek
4. "Schedule my posts for next week" → should use OpenAI
5. "Create a visual for Instagram" → should use Gemini
6. Follow-up "sounds good" → should stick with last provider (thread continuity)

(Provider is invisible to user — verify via server logs)

- [ ] **Step 3: Final commit with all changes**

```bash
git add -A
git commit -m "feat: smart router — auto-route chat messages to best AI provider

Implements intelligent provider selection using keyword rules + Gemini Flash
LLM fallback. Includes thread continuity, agent niche mapping, and provider
fallback chain for resilience."
```
