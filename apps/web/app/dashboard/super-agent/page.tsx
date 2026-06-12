"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import { MediaPickerDialog } from "~/components/media-picker-dialog";
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
  Paperclip,
  Image as ImageIcon,
  X as XIcon,
} from "lucide-react";

/* ── Types ── */
interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  // A1 followup: `idempotencyKey` is a STABLE uuid stamped server-side at action
  // creation; it lives inside metadata.action so it survives a getThread refetch.
  action?: { type: string; payload: Record<string, unknown>; idempotencyKey?: string } | null;
  createdAt?: string | Date;
  provider?: string;
}

// A1 followup: the STABLE key used for BOTH the executedActionIds lock and the
// clientActionId sent to the server. Falls back to the (ephemeral) message id for
// legacy messages persisted before idempotencyKey existed.
const actionKey = (msg: Message): string => msg.action?.idempotencyKey ?? msg.id;

// Friendly label for the model that actually answered (B1 transparency).
const PROVIDER_BADGE_LABELS: Record<string, string> = {
  openai: "OpenAI (GPT-4)",
  anthropic: "Anthropic (Claude)",
  gemini: "Google (Gemini)",
  gemma4: "Google (Gemma 4)",
  grok: "xAI (Grok)",
  deepseek: "DeepSeek",
};

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

// Fix #33: icon lookup for capability list (derived from backend SUPPORTED_ACTIONS)
const CAPABILITY_ICONS: Record<string, React.ElementType> = {
  create_agent: Zap,
  generate_content: Sparkles,
  schedule_post: BarChart3,
  bulk_schedule: BarChart3,
  publish_now: PenLine,
  update_agent: Zap,
  generate_news_image: ImagePlus,
  create_campaign: Target,
  create_brand_tracker: Target,
  create_listening_query: Ear,
  update_influencer: Target,
  trigger_agent_run: Newspaper,
  get_analytics: BarChart3,
};

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

  // Fix #33: load capability list from backend
  const { data: capabilitiesData } = trpc.chat.capabilities.useQuery();
  // Show the user which channels are available to post to (audit clarity 2026-06-06)
  const { data: channels } = trpc.channel.list.useQuery();

  /* ── State ── */
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Media attachments the user adds via upload or the library picker (audit fix 2026-06-06)
  const [attachments, setAttachments] = useState<{ mediaId: string; url: string; fileType: string }[]>([]);
  const [showMediaPicker, setShowMediaPicker] = useState(false);
  // A1: per-message lock so an action button can't be re-clicked after it
  // succeeds (would create duplicate LIVE posts). Keyed on the message id, which
  // is also sent as clientActionId for server-side idempotency.
  const [executedActionIds, setExecutedActionIds] = useState<Set<string>>(new Set());

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ── Load thread messages ── */
  const { data: threadData } = trpc.chat.getThread.useQuery(
    { id: activeThreadId! },
    { enabled: !!activeThreadId }
  );

  useEffect(() => {
    if (threadData?.messages) {
      const dbMessages: Message[] = threadData.messages.map((m: any) => ({
        id: m.id,
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
        action: (m.metadata as any)?.action || null,
        createdAt: m.createdAt,
        provider: (m.metadata as any)?.provider || undefined,
      }));

      // A1 followup: re-seed the "Done" lock from PERSISTED markers so it survives
      // a getThread refetch. Every executeAction stamps the result ChatMessage with
      // metadata.executedActionId === <the action's idempotencyKey>. Collect every
      // such marker present in the thread; an action is "done" iff its
      // idempotencyKey is in that set. Without this, the refetch (triggered by the
      // success path's invalidate) would drop the in-memory lock and re-enable the
      // button — letting a re-click create a SECOND LIVE post.
      const executedMarkers = new Set<string>();
      for (const m of threadData.messages as any[]) {
        const marker = (m.metadata as any)?.executedActionId;
        if (typeof marker === "string" && marker) executedMarkers.add(marker);
      }
      if (executedMarkers.size > 0) {
        setExecutedActionIds((prev) => new Set([...prev, ...executedMarkers]));
      }

      // Fix #31: re-inject any pending message that survived a page reload
      if (activeThreadId && typeof window !== "undefined") {
        const pendingRaw = localStorage.getItem(`superagent:pending:${activeThreadId}`);
        if (pendingRaw) {
          try {
            const pending = JSON.parse(pendingRaw) as { id: string; role: "user"; content: string; at: number };
            // Only inject if it's not already in the db messages
            const alreadyPresent = dbMessages.some((m: Message) => m.content === pending.content && m.role === "user");
            if (!alreadyPresent) {
              dbMessages.push({ id: pending.id, role: "user", content: pending.content, action: null, createdAt: new Date(pending.at).toISOString() });
            }
          } catch {}
        }
      }

      setMessages(dbMessages);
    }
  }, [threadData, activeThreadId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  /* ── Execute action ── */
  const executeAction = useCallback(
    async (msg: Message) => {
      if (!activeThreadId || !msg.action) return;
      const action = msg.action;
      // A1 followup: the lock key AND the clientActionId are the STABLE
      // idempotencyKey (falls back to msg.id for legacy messages). This key lives
      // in the persisted metadata.action, so it's identical before AND after a
      // getThread refetch — the server marker stamped on success will match.
      const key = actionKey(msg);
      // Don't re-fire an action that already ran (defensive — the button is also
      // disabled). The server dedupes on clientActionId regardless.
      if (executedActionIds.has(key)) return;
      const postActions = ["publish_now", "schedule_post", "bulk_schedule"];
      let payload = action.payload;
      if (postActions.includes(action.type) && attachments.length > 0 && !("mediaIds" in payload)) {
        payload = { ...payload, mediaIds: attachments.map((a) => a.mediaId) };
      }
      try {
        await executeActionMutation.mutateAsync({
          threadId: activeThreadId,
          actionType: action.type as any,
          payload,
          clientActionId: key,
        });
        // Success-only add — a FAILED publish must NOT lock the button.
        setExecutedActionIds((prev) => new Set(prev).add(key));
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
    [activeThreadId, executeActionMutation, utils, attachments, executedActionIds]
  );

  /* ── Send message ── */
  // Upload an image/video and attach it to the next message (audit fix 2026-06-06)
  const handleFileUpload = useCallback(async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Upload failed");
      }
      const { id, url, fileType } = await res.json();
      setAttachments((prev) => [...prev, { mediaId: id, url, fileType: fileType || file.type }]);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, role: "system", content: `Upload failed: ${e.message}` },
      ]);
    }
  }, []);

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

    // Fix #31: persist pending message to localStorage so a page reload mid-stream
    // doesn't lose the user's message
    const pendingKey = `superagent:pending:${tid}`;
    if (typeof window !== "undefined") {
      localStorage.setItem(pendingKey, JSON.stringify({ id: userMsg.id, role: "user", content: text, at: Date.now() }));
    }

    // Snapshot + clear attachments so the next message starts fresh
    const attachmentMediaIds = attachments.map((a) => a.mediaId);
    setAttachments([]);

    // Save to DB
    try {
      await sendMessageMutation.mutateAsync({ threadId: tid, content: text, attachmentMediaIds });
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
      if (typeof window !== "undefined") localStorage.removeItem(pendingKey);
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
                  provider: (event as any).provider || undefined,
                },
              ]);
              setStreamingContent("");
              // publish_now is NOT auto-executed — it renders an explicit confirm
              // button with a warning (audit fix 2026-06-06), like every other action.
            } else if (event.type === "error") {
              setMessages((prev) => [
                ...prev,
                { id: `err-${Date.now()}`, role: "system", content: event.message },
              ]);
              setStreamingContent("");
            }
          } catch (e) {
            // Don't silently swallow a malformed SSE event — log it (audit fix 2026-06-06)
            console.error("[super-agent] dropped malformed SSE event", e);
          }
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
      // Fix #31: clear the pending message once streaming is done
      if (typeof window !== "undefined") localStorage.removeItem(`superagent:pending:${tid}`);
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
                  Tell me what you want in plain English. I can <strong>generate captions &amp; images</strong>,{" "}
                  <strong>attach your own photos or videos</strong> (use the paperclip below), and{" "}
                  <strong>schedule or publish posts</strong> to your channels.
                </p>
              </div>

              {/* Connected channels — make it obvious where posts can go (audit clarity 2026-06-06) */}
              <div className="flex max-w-md flex-wrap items-center justify-center gap-1.5">
                {(channels ?? []).length === 0 ? (
                  <a href="/dashboard/channels" className="text-xs font-medium text-violet-600 underline">
                    Connect a channel to start posting →
                  </a>
                ) : (
                  <>
                    <span className="text-[11px] text-muted-foreground">Available channels:</span>
                    {(channels ?? []).map((c) => (
                      <Badge key={c.id} variant="secondary" className="text-[10px]">
                        {c.name || c.username || c.platform}
                      </Badge>
                    ))}
                  </>
                )}
              </div>

              {/* Capabilities — Fix #33: derived from backend SUPPORTED_ACTIONS */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {(capabilitiesData ?? []).map(({ action, label, color }) => {
                  const Icon = CAPABILITY_ICONS[action] ?? Sparkles;
                  return (
                    <div key={action} className="flex items-center gap-1.5 rounded-lg border bg-background px-3 py-2">
                      <Icon className={cn("h-3.5 w-3.5", color)} />
                      <span className="text-[11px] text-muted-foreground">{label}</span>
                    </div>
                  );
                })}
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
                    {msg.role === "assistant" && msg.provider && (
                      <div className="mt-1.5 text-[10px] text-muted-foreground/70">
                        {PROVIDER_BADGE_LABELS[msg.provider] ?? msg.provider}
                      </div>
                    )}
                    {msg.action && (
                      <div className="mt-3 border-t border-foreground/10 pt-2">
                        {msg.action.type === "publish_now" && (
                          <div className="mb-2 flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
                            <AlertCircle className="h-3 w-3 shrink-0" />
                            This will publish immediately to your selected channels. It cannot be undone.
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px]">
                            {msg.action.type.replace(/_/g, " ")}
                          </Badge>
                          {executedActionIds.has(actionKey(msg)) ? (
                            <span className="flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                              <CheckCircle2 className="h-3 w-3" />
                              Done
                            </span>
                          ) : (
                            <Button
                              size="sm"
                              className="h-6 gap-1 text-xs bg-violet-600 hover:bg-violet-700 text-white"
                              onClick={() => executeAction(msg)}
                              disabled={executeActionMutation.isPending || executedActionIds.has(actionKey(msg))}
                            >
                              {executeActionMutation.isPending ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <CheckCircle2 className="h-3 w-3" />
                              )}
                              {msg.action.type === "publish_now" ? "Publish now" : "Execute"}
                            </Button>
                          )}
                        </div>
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
          <div className="mx-auto max-w-3xl">
            {/* Attachment thumbnails (audit fix 2026-06-06) */}
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2">
                {attachments.map((a, i) => (
                  <div key={a.mediaId} className="relative h-14 w-14 overflow-hidden rounded-md border">
                    {a.fileType.startsWith("video") ? (
                      <video src={a.url} className="h-full w-full object-cover" />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.url} alt="attachment" className="h-full w-full object-cover" />
                    )}
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                      className="absolute right-0 top-0 rounded-bl bg-black/60 p-0.5 text-white"
                      aria-label="Remove attachment"
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-end gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFileUpload(f);
                  e.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                title="Upload an image or video"
                className="h-12 w-12 shrink-0 rounded-xl"
                onClick={() => fileInputRef.current?.click()}
                disabled={isStreaming}
              >
                <Paperclip className="h-5 w-5" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                title="Choose from your Media Library"
                className="h-12 w-12 shrink-0 rounded-xl"
                onClick={() => setShowMediaPicker(true)}
                disabled={isStreaming}
              >
                <ImageIcon className="h-5 w-5" />
              </Button>
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

      {/* Media Library picker — adds an existing upload as an attachment */}
      <MediaPickerDialog
        open={showMediaPicker}
        onOpenChange={setShowMediaPicker}
        onSelect={(url, _fileName, mediaId) => {
          if (mediaId) {
            const isVideo = /\.(mp4|mov|webm|m4v|avi)$/i.test(url) || /\.(mp4|mov|webm|m4v|avi)$/i.test(_fileName);
            setAttachments((prev) => [...prev, { mediaId, url, fileType: isVideo ? "video" : "image" }]);
          }
          setShowMediaPicker(false);
        }}
      />
    </div>
  );
}
