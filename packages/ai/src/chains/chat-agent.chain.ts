import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { getModel, isLangChainProvider } from "../providers/provider.factory";
import { callGemini } from "../providers/gemini.provider";
import { callGemma4 } from "../providers/gemma4.provider";
import { CHAT_AGENT_SYSTEM_PROMPT } from "../prompts/chat-agent.prompt";
import { isAllowedImageUrl } from "../utils/safe-fetch-url";
import type { AIProvider } from "../types";

export type ChatMessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string | ChatMessageContentPart[];
}

export interface ChatContext {
  channels: Array<{ id: string; name: string; platform: string; username?: string }>;
  agents: Array<{ id: string; name: string; niche: string; isActive: boolean; postsPerDay?: number; totalPosts?: number }>;
  campaigns?: Array<{ id: string; name: string; status: string; brandCount: number }>;
  listeningQueries?: Array<{ id: string; query: string; platforms: string[]; mentionCount: number }>;
  influencers?: Array<{ id: string; name: string; platform: string; handle: string; status: string; followers: number }>;
  recentPosts?: Array<{ id: string; content: string; status: string; createdAt: string }>;
  stats?: { totalPosts: number; published: number; scheduled: number; connectedChannels: number };
  trendingNews?: Array<{
    title: string;
    source: string;
    link: string;
    summary: string;
  }>;
  orgLogo?: string;
  orgName?: string;
}

export type ChatActionType =
  | "create_agent"
  | "generate_content"
  | "schedule_post"
  | "bulk_schedule"
  | "publish_now"
  | "update_agent"
  | "generate_news_image"
  | "create_campaign"
  | "create_brand_tracker"
  | "create_listening_query"
  | "update_influencer"
  | "trigger_agent_run"
  | "get_analytics";

export interface ChatAgentAction {
  type: ChatActionType;
  payload: Record<string, unknown>;
  /**
   * A1 followup: a stable idempotency key generated ONCE when the action is first
   * parsed from the model output. It is sent in the SSE `done` event AND persisted
   * into the assistant ChatMessage.metadata.action, so it survives the
   * streaming→persisted message-id transition (the ephemeral `ai-<ts>` id is
   * replaced by the DB id on the next getThread refetch). The client uses this key
   * as BOTH the executedActionIds lock key AND the clientActionId sent to the
   * server, so a re-click after a refetch short-circuits server-side instead of
   * creating a second LIVE post.
   */
  idempotencyKey?: string;
}

/**
 * Parse action blocks from AI response text.
 * Looks for ```action ... ``` blocks and extracts JSON.
 */
export function parseActions(text: string): ChatAgentAction | null {
  const actionMatch = text.match(/```action\s*\n([\s\S]*?)\n```/);
  if (!actionMatch?.[1]) return null;

  try {
    const parsed = JSON.parse(actionMatch[1]);
    if (parsed.type && parsed.payload) {
      return parsed as ChatAgentAction;
    }
  } catch {
    // Invalid JSON in action block
  }
  return null;
}

/**
 * Attach a STABLE idempotency key to a parsed action (A1 followup).
 *
 * Pure helper so the same key is guaranteed to be used for BOTH the SSE `done`
 * event and the persisted `metadata.action` — call this ONCE per assistant
 * message, then send + persist the returned object. Returns `null` unchanged so
 * the caller can pass through "no action" responses. If the action already has a
 * key (defensive — e.g. re-processing) it is preserved rather than regenerated.
 */
export function withIdempotencyKey(
  action: ChatAgentAction | null,
  generateKey: () => string = () => globalThis.crypto.randomUUID()
): ChatAgentAction | null {
  if (!action) return null;
  if (action.idempotencyKey) return action;
  return { ...action, idempotencyKey: generateKey() };
}

/**
 * Remove action blocks from display text so users see clean messages.
 */
export function cleanResponseText(text: string): string {
  return text.replace(/```action\s*\n[\s\S]*?\n```/g, "").trim();
}

function buildContextString(context: ChatContext): string {
  const parts: string[] = [];

  // Organization
  if (context.orgName) parts.push(`Organization: ${context.orgName}`);
  if (context.orgLogo) parts.push(`Logo URL: ${context.orgLogo}`);

  // Stats overview
  if (context.stats) {
    parts.push(`\nPlatform Stats: ${context.stats.totalPosts} total posts, ${context.stats.published} published, ${context.stats.scheduled} scheduled, ${context.stats.connectedChannels} channels`);
  }

  // Channels
  if (context.channels.length > 0) {
    parts.push("\nConnected channels:");
    context.channels.forEach((ch) => {
      parts.push(`  - ${ch.name}${ch.username ? ` (@${ch.username})` : ""} [${ch.platform}] (ID: ${ch.id})`);
    });
  } else {
    parts.push("\nNo channels connected yet. The user needs to connect social media channels first.");
  }

  // Agents
  if (context.agents.length > 0) {
    parts.push("\nAI Agents:");
    context.agents.forEach((a) => {
      parts.push(`  - ${a.name} (${a.niche}, ${a.isActive ? "active" : "paused"}${a.totalPosts ? `, ${a.totalPosts} posts created` : ""}, ID: ${a.id})`);
    });
  }

  // Campaigns
  if (context.campaigns && context.campaigns.length > 0) {
    parts.push("\nCampaigns:");
    context.campaigns.forEach((c) => {
      parts.push(`  - ${c.name} [${c.status}] (${c.brandCount} brands tracked, ID: ${c.id})`);
    });
  }

  // Listening queries
  if (context.listeningQueries && context.listeningQueries.length > 0) {
    parts.push("\nListening Queries:");
    context.listeningQueries.forEach((q) => {
      parts.push(`  - "${q.query}" on ${q.platforms.join(", ")} (${q.mentionCount} mentions, ID: ${q.id})`);
    });
  }

  // Influencers summary
  if (context.influencers && context.influencers.length > 0) {
    const byStatus: Record<string, number> = {};
    context.influencers.forEach((i) => { byStatus[i.status] = (byStatus[i.status] || 0) + 1; });
    parts.push(`\nInfluencers: ${context.influencers.length} total (${Object.entries(byStatus).map(([s, c]) => `${c} ${s}`).join(", ")})`);
  }

  // Recent posts
  if (context.recentPosts && context.recentPosts.length > 0) {
    parts.push("\nRecent posts:");
    context.recentPosts.slice(0, 5).forEach((p) => {
      parts.push(`  - [${p.status}] "${p.content.slice(0, 80)}..." (${p.createdAt})`);
    });
  }

  // Trending news
  if (context.trendingNews && context.trendingNews.length > 0) {
    parts.push("\n## Trending News (fetched just now — present these to the user)");
    context.trendingNews.forEach((article, i) => {
      parts.push(`  ${i + 1}. "${article.title}" — ${article.source}`);
      parts.push(`     Link: ${article.link}`);
      if (article.summary) {
        parts.push(`     Summary: ${article.summary.slice(0, 200)}`);
      }
    });
    parts.push("\nBased on these headlines, present the top stories and draft a social media post from the most relevant one. Include a generate_news_image action block.");
  }

  return parts.join("\n");
}

/**
 * Host allowlist for server-side image fetches (SSRF guard). Attachment URLs
 * are written by our own org-scoped S3/MinIO upload flow, so the only legitimate
 * hosts are the configured S3 public/endpoint hosts. We fail closed: anything
 * not on the allowlist (and any private/loopback/link-local host) is rejected.
 *
 * The allow/deny logic now lives in the shared `../utils/safe-fetch-url`
 * module (`isAllowedImageUrl`); this file delegates to it so all server-side
 * image fetches enforce one guard.
 */

/** @internal exported for SSRF-guard unit tests */
export const __isAllowedImageUrl = isAllowedImageUrl;

async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  if (!isAllowedImageUrl(url)) {
    console.warn(`[chat-agent] image fetch blocked (host not allowlisted / private): ${url.slice(0, 80)}`);
    return null;
  }
  try {
    // redirect:"manual" so a 30x cannot bounce the request to an internal target.
    const res = await fetch(url, { redirect: "manual" });
    if (!res.ok) {
      console.warn(`[chat-agent] image fetch for Gemini failed: HTTP ${res.status} for ${url.slice(0, 80)}`);
      return null;
    }
    const mimeType = res.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await res.arrayBuffer());
    return { data: buf.toString("base64"), mimeType };
  } catch (e) {
    console.warn(`[chat-agent] image fetch for Gemini threw: ${(e as Error).message} for ${url.slice(0, 80)}`);
    return null;
  }
}

/**
 * Stream chat responses using LangChain (OpenAI/Anthropic).
 * Returns an async generator that yields text chunks.
 */
export async function* streamChatAgent(
  provider: AIProvider,
  messages: ChatMessage[],
  context: ChatContext
): AsyncGenerator<string> {
  const contextStr = buildContextString(context);
  const systemPrompt = `${CHAT_AGENT_SYSTEM_PROMPT}\n\n## Current User Context\n${contextStr}`;

  if (isLangChainProvider(provider)) {
    const model = getModel(provider, 0.7);

    // The LLM API only allows a single system message as the very first
    // message. DB-stored system messages (e.g. "news image generated",
    // action confirmations) are informational — re-present them as
    // AIMessages so the model retains context about performed actions
    // without violating the API constraint.
    const langchainMessages = [
      new SystemMessage(systemPrompt),
      ...messages.map((m) => {
        if (m.role === "user") return new HumanMessage({ content: m.content as any });
        // Treat both "assistant" and "system" DB messages as AI messages
        // so system notes (action confirmations, etc.) stay in context
        // but never appear as a second SystemMessage.
        return new AIMessage(typeof m.content === "string" ? m.content : "");
      }),
    ];

    const stream = await model.stream(langchainMessages);
    for await (const chunk of stream) {
      const text = typeof chunk.content === "string" ? chunk.content : "";
      if (text) yield text;
    }
  } else if (provider === "gemma4") {
    // Gemma4: text-only, non-streaming fallback
    const formattedMessages = messages
      .map((m) => {
        const text = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join(" ");
        if (m.role === "user") return `User: ${text}`;
        if (m.role === "system") return `System note: ${text}`;
        return `Assistant: ${text}`;
      })
      .join("\n\n");

    const fullPrompt = `${systemPrompt}\n\n${formattedMessages}\n\nAssistant:`;
    const response = await callGemma4(fullPrompt);

    // Yield in chunks to simulate streaming
    const words = response.split(" ");
    for (let i = 0; i < words.length; i += 3) {
      yield words.slice(i, i + 3).join(" ") + " ";
    }
  } else {
    // Gemini branch — supports multimodal via inlineData parts.
    const contents: any[] = [{ role: "user", parts: [{ text: systemPrompt }] }];
    for (const m of messages) {
      const role = m.role === "assistant" ? "model" : "user";
      if (typeof m.content === "string") {
        contents.push({ role, parts: [{ text: m.content }] });
      } else {
        const parts: any[] = [];
        for (const part of m.content) {
          if (part.type === "text") parts.push({ text: part.text });
          else if (part.type === "image_url") {
            const img = await fetchImageAsBase64(part.image_url.url);
            if (img) parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
          }
        }
        contents.push({ role, parts });
      }
    }
    const text = await callGemini(contents as any, { temperature: 0.7 });
    yield text;
    return;
  }
}

/**
 * Non-streaming version for simple use cases.
 */
export async function chatAgent(
  provider: AIProvider,
  messages: ChatMessage[],
  context: ChatContext
): Promise<string> {
  let fullResponse = "";
  for await (const chunk of streamChatAgent(provider, messages, context)) {
    fullResponse += chunk;
  }
  return fullResponse;
}
