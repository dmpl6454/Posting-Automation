# Smart Router — Intelligent Multi-Provider Chat Agent

## Overview

Replace static provider selection in the chat stream route with an intelligent router that automatically picks the best AI provider (OpenAI, Anthropic, Gemini, Grok, DeepSeek) per message based on content and context.

## Design Decisions

- **Auto-routing**: System picks the provider — user never selects manually
- **Hybrid routing**: Rules-based keyword matching for obvious cases, Gemini Flash LLM fallback for ambiguous messages
- **Invisible selection**: No provider badges or indicators shown to the user
- **Approach 1**: Router module called in the stream route, before `streamChatAgent()`

## Architecture

### Smart Router Module

**File:** `packages/ai/src/routing/smart-router.ts`

Single exported function:

```ts
export async function routeProvider(
  message: string,
  context: {
    threadHistory?: Array<{ role: string; content: string }>;
    hasAttachments?: boolean;
    agentNiche?: string;
    lastProvider?: AIProvider;
  }
): Promise<AIProvider>
```

### Routing Logic (in priority order)

1. **Thread continuity (sticky provider)**: If `lastProvider` is set (from the most recent assistant message in the thread), prefer that same provider unless there is a strong keyword signal to switch. This prevents jarring personality changes mid-conversation.

2. **Keyword rules**: If 2+ keywords from a single category match, route to that provider. If keywords from multiple categories match (compound query like "analyze trending data"), skip rules and fall through to LLM classifier.

| Priority | Keywords | Provider | Reason |
|----------|----------|----------|--------|
| 1 | "trending", "breaking", "news", "viral", "what's happening" | grok | Real-time awareness |
| 2 | "imagine", "creative", "story", "write me", "brainstorm", "poem" | anthropic | Creative writing strength |
| 3 | "analyze", "compare", "data", "statistics", "research", "summarize" | deepseek | Analytical/reasoning strength |
| 4 | "schedule", "plan", "optimize", "format", "JSON", "list", "steps" | openai | Structured output reliability |
| 5 | `hasAttachments: true` or "image", "photo", "design", "visual" | gemini | Multimodal capability |

Keywords extracted into a `ROUTING_RULES` constant at the top of the file for easy tuning.

3. **Agent niche hint**: If no keyword match and `agentNiche` is set, map niche to a default provider (e.g., news niche → grok, creative niche → anthropic). Falls through to LLM classifier if niche doesn't map.

4. **LLM fallback (Gemini Flash)**: For ambiguous messages with no keyword or niche match. Uses `callGemini()` directly (Gemini does not use LangChain). Wrapped in try/catch with a 2-second timeout — on any failure (network error, timeout, malformed response), defaults to `openai`. This adds ~200-500ms latency for ambiguous messages only; keyword-matched messages have zero additional latency.

```
Prompt: "Classify this social media message into one category:
- trending (real-time news/events)
- creative (storytelling, copywriting)
- analytical (data, comparison, research)
- structured (scheduling, formatting, planning)
- visual (images, design, multimodal)

Message: {message}

Reply with ONLY the category name."
```

Category → provider: trending→grok, creative→anthropic, analytical→deepseek, structured→openai, visual→gemini. Unknown category → openai.

## Stream Route Integration

**File:** `apps/web/app/api/chat/stream/route.ts`

Current static selection (line 102-103):
```ts
const provider: AIProvider =
  body.provider || (thread.agent?.aiProvider as AIProvider) || "anthropic";
```

New flow:
```ts
// Priority: explicit client request > agent preference > smart router
let provider: AIProvider;
if (body.provider) {
  provider = body.provider;
} else if (thread.agent?.aiProvider) {
  provider = thread.agent.aiProvider as AIProvider;
} else {
  const lastAssistantMsg = dbMessages.filter(m => m.role === "assistant").pop();
  provider = await routeProvider(lastUserMessage, {
    threadHistory: messages.slice(-6),
    hasAttachments: !!attachments?.length,
    agentNiche: thread.agent?.niche,
    lastProvider: lastAssistantMsg?.metadata?.provider as AIProvider | undefined,
  });
}
```

**Relationship with `detectTrendingIntent()`**: The existing `detectTrendingIntent()` function (used earlier in the route to fetch news) remains unchanged. It serves a different purpose — it triggers news fetching and injects trending context into the chat. The router's "trending" keyword match routes to Grok as the provider. These are complementary: trending intent detection fetches news context, then Grok generates the response using that context.

## Error Handling & Fallbacks

**Pre-stream errors only.** If `streamChatAgent()` throws before yielding any chunks (auth failure, connection error, invalid API key), the fallback activates:

1. Catch the error
2. Fallback chain: `openai → anthropic → grok → deepseek → gemini` (skip the failed provider)
3. Max 1 fallback attempt — if it also fails, return error message to user
4. Log: failed provider, error type, fallback provider used

**Mid-stream errors** (provider fails after some chunks have been written to SSE): No silent retry — send an SSE error event so the frontend can display "Response interrupted, please try again." Retrying mid-stream would produce garbled output (partial response from Provider A + full response from Provider B).

## Files Changed

| Action | File | What |
|--------|------|------|
| Create | `packages/ai/src/routing/smart-router.ts` | `routeProvider()` + keyword rules + Gemini Flash fallback |
| Modify | `packages/ai/src/index.ts` | Export `routeProvider` |
| Modify | `apps/web/app/api/chat/stream/route.ts` | Replace static provider selection with `routeProvider()` + fallback chain |

## Testing

- **Keyword routing**: Single-category keyword message → correct provider
- **Keyword overlap**: Message matches multiple categories → falls through to LLM classifier
- **Thread continuity**: Same-thread follow-up with no strong signal → sticky to last provider
- **Agent override**: Agent with `aiProvider` set → router bypassed
- **Client override**: `body.provider` set → router bypassed
- **LLM fallback**: No keyword match → Gemini Flash classification runs
- **LLM fallback failure**: Gemini Flash times out or errors → defaults to openai
- **Pre-stream fallback**: Provider auth failure → next provider in chain used
- **Mid-stream error**: Provider fails after chunks → SSE error event sent
- **All providers fail**: Every fallback fails → error message returned to user
