"use client";

import { useEffect, useRef } from "react";
import { trpc } from "~/lib/trpc/client";
import { useChatStream } from "~/hooks/use-chat-stream";
import { MessageBubble } from "./MessageBubble";
import { ChatInput } from "./ChatInput";
import { TypingIndicator } from "./TypingIndicator";
import { Bot, MessageSquare } from "lucide-react";

interface ChatViewProps {
  threadId: string | null;
  onThreadCreated?: (threadId: string) => void;
}

export function ChatView({ threadId, onThreadCreated }: ChatViewProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const {
    messages,
    isStreaming,
    streamingContent,
    sendMessage,
    executeAction,
    loadMessages,
    isExecuting,
  } = useChatStream(threadId);

  const createThread = trpc.chat.createThread.useMutation();

  // Load thread messages
  const { data: threadData } = trpc.chat.getThread.useQuery(
    { id: threadId! },
    { enabled: !!threadId }
  );

  useEffect(() => {
    if (threadData?.messages) {
      loadMessages(threadData.messages as any);
    }
  }, [threadData, loadMessages]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  const handleSend = async (content: string, attachmentMediaIds?: string[]) => {
    if (!threadId) {
      // Create a new thread first
      const thread = await createThread.mutateAsync({ title: content.slice(0, 50) });
      onThreadCreated?.(thread.id);
      // The parent will update threadId, but we can send immediately
      // by calling sendMessage with the new threadId via a slight delay
      setTimeout(() => {
        sendMessage(content, attachmentMediaIds);
      }, 100);
      return;
    }
    sendMessage(content, attachmentMediaIds);
  };

  // Empty state when no thread selected
  if (!threadId) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="rounded-full bg-purple-100 p-4 dark:bg-purple-900/30">
            <Bot className="h-10 w-10 text-purple-600 dark:text-purple-400" />
          </div>
          <div>
            <h2 className="text-xl font-semibold">AI Agent Assistant</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Chat with your AI assistant to create agents, generate social media content,
              schedule posts, and get strategy advice.
            </p>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {[
              "Create an agent that posts daily about tech",
              "Write me a LinkedIn post about AI trends",
              "What's the best time to post on Instagram?",
              "Generate a Twitter thread about productivity",
            ].map((suggestion) => (
              <button
                key={suggestion}
                onClick={() => handleSend(suggestion)}
                className="rounded-xl border bg-muted/30 p-3 text-left text-sm transition-colors hover:bg-muted/60"
              >
                <MessageSquare className="mb-1 h-4 w-4 text-muted-foreground" />
                {suggestion}
              </button>
            ))}
          </div>
        </div>
        <ChatInput onSend={handleSend} placeholder="Ask anything about social media..." />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 && !isStreaming && (
          <div className="flex h-full items-center justify-center p-8">
            <div className="text-center text-muted-foreground">
              <Bot className="mx-auto mb-2 h-8 w-8" />
              <p className="text-sm">Start the conversation...</p>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            onExecuteAction={executeAction}
            isExecuting={isExecuting}
          />
        ))}

        {/* Streaming message */}
        {isStreaming && streamingContent && (
          <MessageBubble
            message={{
              id: "streaming",
              role: "assistant",
              content: streamingContent,
            }}
          />
        )}

        {isStreaming && !streamingContent && <TypingIndicator />}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <ChatInput
        onSend={handleSend}
        disabled={isStreaming}
        placeholder={
          threadData?.agent
            ? `Message ${threadData.agent.name}...`
            : "Type a message..."
        }
      />
    </div>
  );
}
