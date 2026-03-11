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
  channels: Array<{ id: string; name: string; platform: string }>;
  agents: Array<{ id: string; name: string; niche: string; isActive: boolean }>;
}

export interface ChatAgentAction {
  type: "create_agent" | "generate_content" | "schedule_post" | "update_agent";
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

  if (context.channels.length > 0) {
    parts.push("Connected channels:");
    context.channels.forEach((ch) => {
      parts.push(`  - ${ch.name} (${ch.platform}, ID: ${ch.id})`);
    });
  } else {
    parts.push("No channels connected yet. The user needs to connect social media channels first.");
  }

  if (context.agents.length > 0) {
    parts.push("\nExisting agents:");
    context.agents.forEach((a) => {
      parts.push(`  - ${a.name} (${a.niche}, ${a.isActive ? "active" : "paused"}, ID: ${a.id})`);
    });
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

    const langchainMessages = [
      new SystemMessage(systemPrompt),
      ...messages.map((m) => {
        if (m.role === "user") return new HumanMessage(m.content);
        if (m.role === "assistant") return new AIMessage(m.content);
        return new SystemMessage(m.content);
      }),
    ];

    const stream = await model.stream(langchainMessages);
    for await (const chunk of stream) {
      const text = typeof chunk.content === "string" ? chunk.content : "";
      if (text) yield text;
    }
  } else {
    // Gemini: non-streaming fallback (generate full response)
    const formattedMessages = messages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
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
