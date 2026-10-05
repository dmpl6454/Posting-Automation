"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, Loader2, RefreshCw, Send, ShieldAlert } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { humanizeError } from "~/lib/errors";
import { useToast } from "~/hooks/use-toast";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Skeleton } from "~/components/ui/skeleton";
import { RelativeTime } from "~/components/comments/comment-thread";
import { isUnconfirmedSend, messageLength, messagingWindowLabel, participantLabel } from "~/lib/messages";
import { cn } from "~/lib/utils";

type Platform = "FACEBOOK" | "INSTAGRAM";

/**
 * One Messenger / Instagram Direct conversation (2026-10-05): the newest
 * messages Meta lets us read (up to 20), the 24-hour reply window, and a
 * composer. Live from Meta; refreshes every 30 seconds while open.
 */
export function MessageThread({
  channelId,
  conversationId,
  platform,
  accountName,
}: {
  channelId: string;
  conversationId: string;
  platform: Platform;
  accountName: string;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState("");
  // The last send's outcome was unknown — it may already be in the thread.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const utils = trpc.useUtils();

  const query = trpc.message.thread.useQuery(
    { channelId, conversationId },
    { retry: false, refetchOnWindowFocus: false, refetchInterval: 30_000, staleTime: 15_000 }
  );
  const thread = query.data;
  const messageCount = thread?.messages.length ?? 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messageCount]);

  const send = trpc.message.send.useMutation({
    onSuccess: () => {
      setDraft("");
      setUnconfirmed(false);
      void query.refetch();
      void utils.message.conversations.invalidate({ channelId });
    },
    onError: (err) => {
      if (isUnconfirmedSend(err.message)) {
        // Sending is not idempotent — never leave a one-click duplicate.
        toast({ title: "Message not confirmed", description: "It may already have been sent — check the conversation before sending again." });
        setUnconfirmed(true);
        void query.refetch();
        return;
      }
      toast({ title: "Couldn't send the message", description: humanizeError(err), variant: "destructive" });
    },
  });

  const len = messageLength(platform, draft);
  const windowInfo = thread ? messagingWindowLabel(thread) : null;
  const closed = thread?.windowOpen === false;

  const submit = () => {
    const text = draft.trim();
    if (!text || send.isPending || closed || len.used > len.max) return;
    send.mutate({ channelId, conversationId, text });
  };

  if (query.isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-2/3" />
        ))}
      </div>
    );
  }
  if (query.isError && !thread) {
    return (
      <div className="space-y-2 rounded-md border border-destructive/40 p-3 text-sm">
        <p className="flex items-start gap-2 text-destructive">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" /> {humanizeError(query.error)}
        </p>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void query.refetch()}>
          <RefreshCw className="mr-1 h-3 w-3" /> Try again
        </Button>
      </div>
    );
  }
  if (!thread) return null;

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="message-thread">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{participantLabel(thread.participant)}</p>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          title="Load the newest messages"
        >
          <RefreshCw className={cn("h-3 w-3", query.isFetching && "animate-spin")} />
        </Button>
      </div>

      <div className="max-h-[55vh] min-h-[8rem] space-y-2 overflow-y-auto rounded-md border bg-muted/30 p-3">
        {thread.messages.length === 0 ? (
          <p className="text-xs text-muted-foreground">No messages to show.</p>
        ) : (
          thread.messages.map((m) => (
            <div key={m.id} className={cn("flex", m.fromAccount ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[80%] space-y-1 rounded-lg px-3 py-2 text-sm",
                  m.fromAccount ? "bg-primary text-primary-foreground" : "bg-background ring-1 ring-border"
                )}
              >
                {m.text && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
                {m.attachments.map((a, i) =>
                  a.previewUrl ? (
                    // Only ever an IMAGE url (the parser never puts a video file here).
                    <a key={i} href={a.url ?? a.previewUrl} target="_blank" rel="noopener noreferrer" className="block">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={a.previewUrl} alt={a.name ?? a.kind} className="max-h-48 rounded" />
                    </a>
                  ) : (
                    <a
                      key={i}
                      href={a.url ?? undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs underline"
                    >
                      <FileText className="h-3 w-3" /> {a.name ?? (a.kind === "share" ? "Shared post" : `[${a.kind}]`)}
                    </a>
                  )
                )}
                {!m.text && m.attachments.length === 0 && <p className="text-xs italic opacity-70">[unsupported message]</p>}
                <p className="text-[10px]">
                  <RelativeTime value={m.createdAt} className={cn("text-[10px]", m.fromAccount && "text-primary-foreground/80")} />
                </p>
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
      <p className="text-[11px] text-muted-foreground">Meta shows the newest 20 messages of a conversation.</p>

      {windowInfo && (
        <p
          className={cn(
            "rounded-md p-2 text-[11px]",
            windowInfo.tone === "open"
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
              : windowInfo.tone === "closed"
                ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                : "bg-muted text-muted-foreground"
          )}
          data-testid="message-window"
        >
          {windowInfo.text}
        </p>
      )}

      {unconfirmed && (
        <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-400">
          Your last message may already have been sent — check the conversation above before sending it again.
        </p>
      )}

      <div className="space-y-1.5">
        <Textarea
          value={draft}
          rows={3}
          disabled={closed}
          placeholder={closed ? "Wait for them to write again" : `Reply as ${accountName}…`}
          className="text-sm"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="h-8 px-3 text-xs"
            disabled={closed || send.isPending || !draft.trim() || len.used > len.max}
            onClick={submit}
            title={`Send as ${accountName} (Ctrl/⌘+Enter)`}
            data-testid="message-send"
          >
            {send.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Send className="mr-1 h-3 w-3" />}
            {unconfirmed ? "Send again anyway" : "Send"}
          </Button>
          <span className={cn("ml-auto text-[10px]", len.used > len.max ? "text-destructive" : "text-muted-foreground")}>
            {len.used.toLocaleString()}/{len.max.toLocaleString()}
            {len.unit ? ` ${len.unit}` : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
