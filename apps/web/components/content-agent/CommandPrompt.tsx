"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";
import {
  Send,
  Loader2,
  Bot,
  User,
  Zap,
  X,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  action?: { type: string; payload: Record<string, unknown> } | null;
}

export function CommandPrompt() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const createThread = trpc.chat.createThread.useMutation();
  const sendMessageMutation = trpc.chat.sendMessage.useMutation();
  const executeActionMutation = trpc.chat.executeAction.useMutation();
  const utils = trpc.useUtils();

  useEffect(() => {
    if (expanded) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, streamingContent, expanded]);

  const executeAction = useCallback(
    async (action: { type: string; payload: Record<string, unknown> }, tid: string) => {
      try {
        await executeActionMutation.mutateAsync({
          threadId: tid,
          actionType: action.type as any,
          payload: action.payload,
        });
        utils.chat.listThreads.invalidate();
        utils.agent.list.invalidate();
      } catch (error: any) {
        setMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}`,
            role: "system",
            content: `Action failed: ${error.message}`,
          },
        ]);
      }
    },
    [executeActionMutation, utils]
  );

  const handleSubmit = async () => {
    const content = input.trim();
    if (!content || isStreaming) return;

    setInput("");
    setExpanded(true);

    // Add user message
    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content,
    };
    setMessages((prev) => [...prev, userMsg]);

    // Create thread if needed
    let tid = threadId;
    if (!tid) {
      try {
        const thread = await createThread.mutateAsync({ title: content.slice(0, 50) });
        tid = thread.id;
        setThreadId(tid);
      } catch {
        setMessages((prev) => [
          ...prev,
          { id: `error-${Date.now()}`, role: "system", content: "Failed to start conversation." },
        ]);
        return;
      }
    }

    // Save user message
    try {
      await sendMessageMutation.mutateAsync({ threadId: tid, content });
    } catch {
      return;
    }

    // Stream AI response
    setIsStreaming(true);
    setStreamingContent("");
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: tid }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error("Stream failed");

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No body");

      const decoder = new TextDecoder();
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        for (const line of text.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);
            if (event.type === "chunk") {
              accumulated += event.content;
              setStreamingContent(accumulated);
            } else if (event.type === "done") {
              const assistantMsg: Message = {
                id: `assistant-${Date.now()}`,
                role: "assistant",
                content: event.displayText || accumulated,
                action: event.action || null,
              };
              setMessages((prev) => [...prev, assistantMsg]);
              setStreamingContent("");

              // Auto-execute publish_now actions
              if (event.action?.type === "publish_now") {
                executeAction(event.action, tid!);
              }
            } else if (event.type === "error") {
              setMessages((prev) => [
                ...prev,
                { id: `error-${Date.now()}`, role: "system", content: event.message },
              ]);
              setStreamingContent("");
            }
          } catch {}
        }
      }
    } catch (error: any) {
      if (error.name !== "AbortError") {
        setMessages((prev) => [
          ...prev,
          { id: `error-${Date.now()}`, role: "system", content: "Failed to get response." },
        ]);
      }
      setStreamingContent("");
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleExecuteAction = (action: { type: string; payload: Record<string, unknown> }) => {
    if (!threadId) return;
    executeAction(action, threadId);
  };

  const clearConversation = () => {
    setMessages([]);
    setStreamingContent("");
    setThreadId(null);
    setExpanded(false);
  };

  const hasMessages = messages.length > 0 || streamingContent;

  return (
    <div className="rounded-xl border bg-gradient-to-b from-violet-50/50 to-background dark:from-violet-950/20 dark:to-background">
      {/* Input bar */}
      <div className="flex items-start gap-2 p-3">
        <div className="mt-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-100 dark:bg-violet-900/40">
          <Zap className="h-4 w-4 text-violet-600 dark:text-violet-400" />
        </div>
        <div className="flex-1">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask me anything... Create a post, generate images, set up agents, schedule content, analyze trends..."
            className="min-h-[44px] max-h-[120px] resize-none border-0 bg-transparent p-1 text-sm shadow-none focus-visible:ring-0"
            rows={1}
          />
        </div>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={!input.trim() || isStreaming}
          className="mt-1 gap-1.5 bg-violet-600 hover:bg-violet-700"
        >
          {isStreaming ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          <span className="hidden sm:inline">{isStreaming ? "Thinking..." : "Send"}</span>
        </Button>
      </div>

      {/* Quick suggestions when empty */}
      {!hasMessages && !input && (
        <div className="flex flex-wrap gap-1.5 px-3 pb-3">
          {[
            "Create a viral Twitter post about AI",
            "Schedule 5 posts for this week",
            "What's trending in tech today?",
            "Generate a news image",
            "Set up an autopilot agent",
          ].map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => {
                setInput(suggestion);
                textareaRef.current?.focus();
              }}
              className="rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-violet-300 hover:text-foreground"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      {/* Response area */}
      {hasMessages && (
        <>
          <div className="flex items-center justify-between border-t px-3 py-1.5">
            <button
              onClick={() => setExpanded((e) => !e)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
              {messages.length} message{messages.length !== 1 ? "s" : ""}
            </button>
            <button
              onClick={clearConversation}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive"
            >
              <X className="h-3 w-3" />
              Clear
            </button>
          </div>

          {expanded && (
            <div className="max-h-[400px] overflow-y-auto border-t px-3 py-2 space-y-3">
              {messages.map((msg) => (
                <div key={msg.id} className="flex gap-2">
                  <div
                    className={cn(
                      "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                      msg.role === "user"
                        ? "bg-foreground/10"
                        : msg.role === "system"
                          ? "bg-amber-100 dark:bg-amber-900/30"
                          : "bg-violet-100 dark:bg-violet-900/30"
                    )}
                  >
                    {msg.role === "user" ? (
                      <User className="h-3 w-3" />
                    ) : msg.role === "system" ? (
                      <AlertCircle className="h-3 w-3 text-amber-600" />
                    ) : (
                      <Bot className="h-3 w-3 text-violet-600" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="whitespace-pre-wrap text-sm leading-relaxed">
                      {msg.content}
                    </div>
                    {msg.action && (
                      <div className="mt-2 flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          {msg.action.type.replace(/_/g, " ")}
                        </Badge>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 gap-1 text-xs"
                          onClick={() => handleExecuteAction(msg.action!)}
                          disabled={executeActionMutation.isPending}
                        >
                          {executeActionMutation.isPending ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-3 w-3" />
                          )}
                          Execute
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {/* Streaming indicator */}
              {streamingContent && (
                <div className="flex gap-2">
                  <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-100 dark:bg-violet-900/30">
                    <Bot className="h-3 w-3 text-violet-600 animate-pulse" />
                  </div>
                  <div className="whitespace-pre-wrap text-sm leading-relaxed">
                    {streamingContent}
                    <span className="animate-pulse">▊</span>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
