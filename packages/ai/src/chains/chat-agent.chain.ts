import { HumanMessage, AIMessage, SystemMessage } from "@langchain/core/messages";
import { getModel, isLangChainProvider } from "../providers/provider.factory";
import { callGemini } from "../providers/gemini.provider";
import { CHAT_AGENT_SYSTEM_PROMPT } from "../prompts/chat-agent.prompt";
import type { AIProvider } from "../types";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
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
        if (m.role === "user") return new HumanMessage(m.content);
        // Treat both "assistant" and "system" DB messages as AI messages
        // so system notes (action confirmations, etc.) stay in context
        // but never appear as a second SystemMessage.
        return new AIMessage(m.content);
      }),
    ];

    const stream = await model.stream(langchainMessages);
    for await (const chunk of stream) {
      const text = typeof chunk.content === "string" ? chunk.content : "";
      if (text) yield text;
    }
  } else {
    // Gemini: non-streaming fallback (generate full response)
    // Map system messages to "System note" so the model knows they are
    // not part of the user/assistant conversation but still has context.
    const formattedMessages = messages
      .map((m) => {
        if (m.role === "user") return `User: ${m.content}`;
        if (m.role === "system") return `System note: ${m.content}`;
        return `Assistant: ${m.content}`;
      })
      .join("\n\n");

    const fullPrompt = `${systemPrompt}\n\n${formattedMessages}\n\nAssistant:`;
    const response = await callGemini(fullPrompt);

    // Yield in chunks to simulate streaming
    const words = response.split(" ");
    for (let i = 0; i < words.length; i += 3) {
      yield words.slice(i, i + 3).join(" ") + " ";
    }
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
