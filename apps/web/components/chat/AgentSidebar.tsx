"use client";

import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Plus, Bot, MessageSquare, Trash2 } from "lucide-react";
import { cn } from "~/lib/utils";

interface AgentSidebarProps {
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onNewChat: () => void;
}

function formatTimeAgo(date: string | Date | null): string {
  if (!date) return "";
  const now = new Date();
  const then = new Date(date);
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;
  return then.toLocaleDateString();
}

export function AgentSidebar({
  activeThreadId,
  onSelectThread,
  onNewChat,
}: AgentSidebarProps) {
  const { data: threads } = trpc.chat.listThreads.useQuery();
  const deleteThread = trpc.chat.deleteThread.useMutation({
    onSuccess: () => {
      utils.chat.listThreads.invalidate();
    },
  });
  const utils = trpc.useUtils();

  return (
    <div className="flex h-full w-72 flex-col border-r bg-muted/20">
      {/* Header */}
      <div className="flex items-center justify-between border-b p-4">
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-purple-500" />
          <h2 className="font-semibold">AI Agents</h2>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={onNewChat}
        >
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>
      </div>

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto p-2">
        {!threads || threads.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
            <MessageSquare className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">
              No conversations yet. Start a new chat!
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {threads.map((thread: any) => {
              const lastMessage = thread.messages?.[0];
              const isActive = thread.id === activeThreadId;

              return (
                <button
                  key={thread.id}
                  onClick={() => onSelectThread(thread.id)}
                  className={cn(
                    "group flex w-full items-start gap-3 rounded-lg p-3 text-left transition-colors",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "hover:bg-muted/60"
                  )}
                >
                  <div
                    className={cn(
                      "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                      thread.agent
                        ? "bg-purple-100 dark:bg-purple-900/30"
                        : "bg-muted"
                    )}
                  >
                    {thread.agent ? (
                      <Bot className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                    ) : (
                      <MessageSquare className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate text-sm font-medium">
                        {thread.title || "New Chat"}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {formatTimeAgo(thread.updatedAt)}
                      </span>
                    </div>
                    {lastMessage && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {lastMessage.role === "user" ? "You: " : "AI: "}
                        {lastMessage.content.slice(0, 50)}
                      </p>
                    )}
                    {thread.agent && (
                      <Badge
                        variant="secondary"
                        className="mt-1 text-[10px] px-1.5 py-0"
                      >
                        {thread.agent.isActive ? "Active" : "Paused"}
                      </Badge>
                    )}
                  </div>

                  {/* Delete button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm("Delete this conversation?")) {
                        deleteThread.mutate({ id: thread.id });
                      }
                    }}
                    className="mt-1 hidden shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:block"
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
  );
}
