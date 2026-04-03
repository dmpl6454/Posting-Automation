"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import {
  Send,
  Loader2,
  Bot,
  User,
  Zap,
  Plus,
  MessageSquare,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  PenLine,
  ImagePlus,
  BarChart3,
  Target,
  Ear,
  Newspaper,
} from "lucide-react";

/* ── Types ── */
interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  action?: { type: string; payload: Record<string, unknown> } | null;
  createdAt?: string | Date;
}

/* ── Helpers ── */
function formatTimeAgo(date: string | Date | null): string {
  if (!date) return "";
  const now = new Date();
  const then = new Date(date);
  const diff = Math.floor((now.getTime() - then.getTime()) / 60000);
  if (diff < 1) return "now";
  if (diff < 60) return `${diff}m`;
  const h = Math.floor(diff / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return then.toLocaleDateString();
}

const capabilities = [
  { icon: PenLine, label: "Create & publish posts", color: "text-blue-500" },
  { icon: Sparkles, label: "Generate AI content", color: "text-purple-500" },
  { icon: ImagePlus, label: "Create images & carousels", color: "text-green-500" },
  { icon: Newspaper, label: "Fetch trending news", color: "text-orange-500" },
  { icon: Zap, label: "Set up autopilot agents", color: "text-yellow-500" },
  { icon: Target, label: "Create campaigns & trackers", color: "text-red-500" },
  { icon: Ear, label: "Monitor social mentions", color: "text-cyan-500" },
  { icon: BarChart3, label: "Get analytics", color: "text-indigo-500" },
];

const quickActions = [
  "Create a viral Twitter post about AI trends",
  "Set up an autopilot agent for tech news",
  "What's trending in technology today?",
  "Schedule 5 posts for this week",
  "Generate a news image about latest headlines",
  "Create a campaign to track competitor brands",
  "Monitor mentions of our brand on social media",
  "Show me my analytics overview",
];

export default function SuperAgentPage() {
  /* ── Thread list ── */
  const { data: threads } = trpc.chat.listThreads.useQuery();
  const createThread = trpc.chat.createThread.useMutation();
  const deleteThread = trpc.chat.deleteThread.useMutation();
  const sendMessageMutation = trpc.chat.sendMessage.useMutation();
  const executeActionMutation = trpc.chat.executeAction.useMutation();
  const utils = trpc.useUtils();

  /* ── State ── */
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  /* ── Load thread messages ── */
  const { data: threadData } = trpc.chat.getThread.useQuery(
    { id: activeThreadId! },
    { enabled: !!activeThreadId }
  );

  useEffect(() => {
    if (threadData?.messages) {
      setMessages(
        threadData.messages.map((m: any) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          action: (m.metadata as any)?.action || null,
          createdAt: m.createdAt,
        }))
      );
    }
  }, [threadData]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  /* ── Execute action ── */
  const executeAction = useCallback(
    async (action: { type: string; payload: Record<string, unknown> }) => {
      if (!activeThreadId) return;
      try {
        await executeActionMutation.mutateAsync({
          threadId: activeThreadId,
          actionType: action.type as any,
          payload: action.payload,
        });
        utils.chat.getThread.invalidate({ id: activeThreadId });
        utils.chat.listThreads.invalidate();
        utils.agent.list.invalidate();
      } catch (error: any) {
        setMessages((prev) => [
          ...prev,
          { id: `err-${Date.now()}`, role: "system", content: `Action failed: ${error.message}` },
        ]);
      }
    },
    [activeThreadId, executeActionMutation, utils]
  );

  /* ── Send message ── */
  const handleSend = async (content?: string) => {
    const text = (content || input).trim();
    if (!text || isStreaming) return;
    setInput("");

    // Create thread if needed
    let tid = activeThreadId;
    if (!tid) {
      try {
        const thread = await createThread.mutateAsync({ title: text.slice(0, 50) });
        tid = thread.id;
        setActiveThreadId(tid);
        utils.chat.listThreads.invalidate();
      } catch {
        return;
      }
    }

    // Add user message optimistically
    const userMsg: Message = { id: `user-${Date.now()}`, role: "user", content: text, createdAt: new Date().toISOString() };
    setMessages((prev) => [...prev, userMsg]);

    // Save to DB
    try {
      await sendMessageMutation.mutateAsync({ threadId: tid, content: text });
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
      return;
    }

    // Stream AI response
    setIsStreaming(true);
    setStreamingContent("");
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: tid }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error("Stream failed");

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No body");

      const decoder = new TextDecoder();
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        for (const line of decoder.decode(value, { stream: true }).split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6).trim());
            if (event.type === "chunk") {
              accumulated += event.content;
              setStreamingContent(accumulated);
            } else if (event.type === "done") {
              setMessages((prev) => [
                ...prev,
                {
                  id: `ai-${Date.now()}`,
                  role: "assistant",
                  content: event.displayText || accumulated,
                  action: event.action || null,
                  createdAt: new Date().toISOString(),
                },
              ]);
              setStreamingContent("");
              if (event.action?.type === "publish_now") executeAction(event.action);
            } else if (event.type === "error") {
              setMessages((prev) => [
                ...prev,
                { id: `err-${Date.now()}`, role: "system", content: event.message },
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
          { id: `err-${Date.now()}`, role: "system", content: "Failed to get response." },
        ]);
      }
      setStreamingContent("");
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
      utils.chat.listThreads.invalidate();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewChat = () => {
    setActiveThreadId(null);
    setMessages([]);
    setStreamingContent("");
    textareaRef.current?.focus();
  };

  const handleSelectThread = (threadId: string) => {
    setActiveThreadId(threadId);
    setStreamingContent("");
  };

  const handleDeleteThread = (threadId: string) => {
    deleteThread.mutate({ id: threadId }, {
      onSuccess: () => {
        utils.chat.listThreads.invalidate();
        if (activeThreadId === threadId) handleNewChat();
      },
    });
  };

  const hasMessages = messages.length > 0 || !!streamingContent;

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      {/* ── Thread Sidebar ── */}
      <div
        className={cn(
          "flex flex-col border-r bg-muted/20 transition-all duration-200",
          sidebarOpen ? "w-72" : "w-0 overflow-hidden"
        )}
      >
        <div className="flex items-center justify-between border-b p-3">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-violet-500" />
            <h2 className="text-sm font-semibold">Conversations</h2>
          </div>
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={handleNewChat}>
            <Plus className="h-3 w-3" /> New
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {!threads || threads.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-6 text-center">
              <MessageSquare className="h-6 w-6 text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground">No conversations yet</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {threads.map((thread: any) => {
                const isActive = thread.id === activeThreadId;
                const lastMsg = thread.messages?.[0];
                return (
                  <button
                    key={thread.id}
                    onClick={() => handleSelectThread(thread.id)}
                    className={cn(
                      "group flex w-full items-start gap-2.5 rounded-lg p-2.5 text-left transition-colors",
                      isActive ? "bg-violet-100/60 dark:bg-violet-900/20" : "hover:bg-muted/60"
                    )}
                  >
                    <div className={cn(
                      "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                      isActive ? "bg-violet-200 dark:bg-violet-800/40" : "bg-muted"
                    )}>
                      <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="truncate text-xs font-medium">{thread.title || "New Chat"}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">{formatTimeAgo(thread.updatedAt)}</span>
                      </div>
                      {lastMsg && (
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {lastMsg.content.slice(0, 60)}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteThread(thread.id); }}
                      className="mt-1 hidden shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:block"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Main Chat Area ── */}
      <div className="flex flex-1 flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 border-b px-4 py-2.5">
          <button
            onClick={() => setSidebarOpen((o) => !o)}
            className="rounded-md p-1 hover:bg-muted lg:hidden"
          >
            <MessageSquare className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-purple-600">
              <Zap className="h-4 w-4 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-semibold">Super Agent</h1>
              <p className="text-[11px] text-muted-foreground">
                Your AI-powered platform operator — ask anything, execute any task
              </p>
            </div>
          </div>
          {isStreaming && (
            <Badge variant="secondary" className="ml-auto animate-pulse gap-1 text-[10px]">
              <Loader2 className="h-3 w-3 animate-spin" /> Thinking...
            </Badge>
          )}
        </div>

        {/* Messages or Welcome */}
        <div className="flex-1 overflow-y-auto">
          {!hasMessages ? (
            /* ── Welcome Screen ── */
            <div className="flex h-full flex-col items-center justify-center gap-6 p-6">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-purple-600 shadow-lg">
                <Zap className="h-8 w-8 text-white" />
              </div>
              <div className="text-center">
                <h2 className="text-xl font-bold">What can I help you with?</h2>
                <p className="mt-1 max-w-md text-sm text-muted-foreground">
                  I can execute any task on your platform — create posts, generate images,
                  set up agents, monitor brands, and more. Just tell me what you need.
                </p>
              </div>

              {/* Capabilities */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {capabilities.map(({ icon: Icon, label, color }) => (
                  <div key={label} className="flex items-center gap-1.5 rounded-lg border bg-background px-3 py-2">
                    <Icon className={cn("h-3.5 w-3.5", color)} />
                    <span className="text-[11px] text-muted-foreground">{label}</span>
                  </div>
                ))}
              </div>

              {/* Quick actions */}
              <div className="grid w-full max-w-2xl gap-2 sm:grid-cols-2">
                {quickActions.map((action) => (
                  <button
                    key={action}
                    onClick={() => handleSend(action)}
                    className="rounded-xl border bg-muted/30 p-3 text-left text-sm transition-all hover:border-violet-300 hover:bg-muted/60"
                  >
                    {action}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            /* ── Message list ── */
            <div className="mx-auto max-w-3xl space-y-4 p-4">
              {messages.map((msg) => (
                <div key={msg.id} className={cn("flex gap-3", msg.role === "user" && "flex-row-reverse")}>
                  <div
                    className={cn(
                      "mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                      msg.role === "user"
                        ? "bg-foreground/10"
                        : msg.role === "system"
                          ? "bg-amber-100 dark:bg-amber-900/30"
                          : "bg-gradient-to-br from-violet-500 to-purple-600"
                    )}
                  >
                    {msg.role === "user" ? (
                      <User className="h-4 w-4" />
                    ) : msg.role === "system" ? (
                      <AlertCircle className="h-4 w-4 text-amber-600" />
                    ) : (
                      <Bot className="h-4 w-4 text-white" />
                    )}
                  </div>
                  <div
                    className={cn(
                      "max-w-[80%] rounded-2xl px-4 py-3",
                      msg.role === "user"
                        ? "bg-violet-600 text-white"
                        : msg.role === "system"
                          ? "bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800"
                          : "bg-muted/60"
                    )}
                  >
                    <div className="whitespace-pre-wrap text-sm leading-relaxed">{msg.content}</div>
                    {msg.action && (
                      <div className="mt-3 flex items-center gap-2 border-t border-foreground/10 pt-2">
                        <Badge variant="outline" className="text-[10px]">
                          {msg.action.type.replace(/_/g, " ")}
                        </Badge>
                        <Button
                          size="sm"
                          className="h-6 gap-1 text-xs bg-violet-600 hover:bg-violet-700 text-white"
                          onClick={() => executeAction(msg.action!)}
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

              {/* Streaming */}
              {streamingContent && (
                <div className="flex gap-3">
                  <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-purple-600">
                    <Bot className="h-4 w-4 text-white animate-pulse" />
                  </div>
                  <div className="max-w-[80%] rounded-2xl bg-muted/60 px-4 py-3">
                    <div className="whitespace-pre-wrap text-sm leading-relaxed">
                      {streamingContent}
                      <span className="animate-pulse">▊</span>
                    </div>
                  </div>
                </div>
              )}

              {isStreaming && !streamingContent && (
                <div className="flex gap-3">
                  <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-purple-600">
                    <Bot className="h-4 w-4 text-white" />
                  </div>
                  <div className="rounded-2xl bg-muted/60 px-4 py-3">
                    <div className="flex gap-1">
                      <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/40" style={{ animationDelay: "0ms" }} />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/40" style={{ animationDelay: "150ms" }} />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/40" style={{ animationDelay: "300ms" }} />
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* ── Input Bar ── */}
        <div className="border-t bg-background p-3">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Tell me what to do..."
              className="min-h-[48px] max-h-[160px] resize-none rounded-xl"
              rows={1}
            />
            <Button
              onClick={() => handleSend()}
              disabled={!input.trim() || isStreaming}
              className="h-12 w-12 shrink-0 rounded-xl bg-violet-600 hover:bg-violet-700"
            >
              {isStreaming ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Send className="h-5 w-5" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
