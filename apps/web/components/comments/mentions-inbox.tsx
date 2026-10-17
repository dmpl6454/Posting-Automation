"use client";

import { useState } from "react";
import { AtSign, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { humanizeError } from "~/lib/errors";
import { classifyReplyFailure } from "~/lib/comment-reply-outcome";
import { useToast } from "~/hooks/use-toast";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Skeleton } from "~/components/ui/skeleton";
import { ChannelAvatar } from "~/components/channel-avatar";
import { RelativeTime } from "~/components/comments/comment-thread";

/**
 * Instagram @mentions (2026-10-17): places where OTHER accounts mentioned one
 * of ours — in their caption or in a comment on their post. Rows arrive only
 * through Meta's `mentions` webhook (there is no endpoint to list them), so an
 * empty list may simply mean that webhook isn't switched on yet.
 *
 * A reply goes on THEIR post, publicly, as our account (POST /{ig-user}/mentions).
 * Creating it is not idempotent — an unknown outcome is shown as such and the
 * button becomes "Send again anyway".
 */

interface Account {
  id: string;
  name: string;
  platform: string;
}

type Show = "open" | "replied" | "dismissed" | "all";

const REPLY_MAX = 2200;

export function MentionsInbox({ accounts }: { accounts: Account[] }) {
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const igAccounts = accounts.filter((a) => a.platform === "INSTAGRAM");
  const [channelId, setChannelId] = useState("");
  const [show, setShow] = useState<Show>("open");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());

  const query = trpc.comment.mentions.useInfiniteQuery(
    { channelId: channelId || undefined, show },
    { getNextPageParam: (last) => last.nextCursor ?? undefined, refetchOnWindowFocus: false }
  );
  const mentions = query.data?.pages.flatMap((p) => p.mentions) ?? [];
  const openCount = query.data?.pages[0]?.openCount ?? 0;

  const setBusyFor = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const reply = trpc.comment.replyMention.useMutation({
    onMutate: (v) => setBusyFor(v.mentionId, true),
    onSettled: (_d, _e, v) => setBusyFor(v.mentionId, false),
    onSuccess: (_r, v) => {
      toast({ title: "Reply posted" });
      setDrafts((prev) => ({ ...prev, [v.mentionId]: "" }));
      setReplyingTo(null);
      void utils.comment.mentions.invalidate();
    },
    onError: (err) => {
      if (classifyReplyFailure(err as any) === "unconfirmed") {
        toast({ title: "Reply not confirmed", description: "It may already be posted — check the post on Instagram first." });
      } else {
        toast({ title: "Couldn't send the reply", description: humanizeError(err), variant: "destructive" });
      }
      void utils.comment.mentions.invalidate();
    },
  });

  const dismiss = trpc.comment.dismissMention.useMutation({
    onSuccess: () => void utils.comment.mentions.invalidate(),
    onError: (err) => toast({ title: "Couldn't update", description: humanizeError(err), variant: "destructive" }),
  });

  const refresh = trpc.comment.refreshMention.useMutation({
    onMutate: (v) => setBusyFor(v.mentionId, true),
    onSettled: (_d, _e, v) => {
      setBusyFor(v.mentionId, false);
      void utils.comment.mentions.invalidate();
    },
    onError: (err) => toast({ title: "Couldn't load the mention", description: humanizeError(err), variant: "destructive" }),
  });

  if (igAccounts.length === 0) {
    return <p className="text-sm text-muted-foreground">Connect an Instagram professional account to see where others mention it.</p>;
  }

  return (
    <div className="space-y-4" data-testid="mentions-inbox">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <AtSign className="h-4 w-4" /> Instagram mentions
          {openCount > 0 && <Badge variant="secondary">{openCount} open</Badge>}
        </h2>
        <p className="text-xs text-muted-foreground">
          When another account @mentions yours in a caption or a comment, it shows up here and you can reply on their post as
          your account. Mentions in stories and from private accounts are never sent by Instagram.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-8 rounded-md border bg-background px-2 text-xs"
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          aria-label="Instagram account"
        >
          <option value="">All Instagram accounts</option>
          {igAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label="Which mentions">
          {(["open", "replied", "dismissed", "all"] as Show[]).map((v) => (
            <Button
              key={v}
              size="sm"
              variant={show === v ? "secondary" : "ghost"}
              className="h-7 px-2.5 text-xs capitalize"
              role="tab"
              aria-selected={show === v}
              onClick={() => setShow(v)}
            >
              {v}
            </Button>
          ))}
        </div>
      </div>

      {query.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : query.isError ? (
        <p className="text-sm text-destructive">{humanizeError(query.error)}</p>
      ) : mentions.length === 0 ? (
        <div className="space-y-1 rounded-md border border-dashed p-4 text-sm text-muted-foreground" data-testid="mentions-empty">
          <p>{show === "open" ? "No mentions waiting for a reply." : "Nothing here."}</p>
          {show === "open" && (
            <p className="text-xs">
              Mentions arrive the moment Instagram reports them. If none ever appear, the mentions feed may not be switched on
              yet: it needs Meta to approve PostAutomation&apos;s comment and Page-management permissions, then a reconnect
              of the Instagram account (Channels → Connect Instagram → Edit settings) so its Page can be subscribed.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {mentions.map((m) => {
            const draft = drafts[m.id] ?? "";
            const isBusy = busy.has(m.id);
            const canWrite = !!m.account && !m.account.disconnected && m.account.canReply !== false;
            const writeReason = !m.account
              ? "This account is no longer in this workspace."
              : m.account.disconnected
                ? "This account was disconnected."
                : m.account.canReply === false
                  ? "Reconnect this account on the Channels page to grant the Instagram comments permission."
                  : undefined;
            return (
              <div key={m.id} className="space-y-2 rounded-md border p-3" data-testid="mention-row">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  {m.account && (
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <ChannelAvatar name={m.account.name} avatar={m.account.avatar} className="h-5 w-5" />
                      {m.account.name}
                    </span>
                  )}
                  <span className="text-muted-foreground">
                    mentioned by {m.username ? <strong>@{m.username}</strong> : "an Instagram account"} in{" "}
                    {m.kind === "comment" ? "a comment" : "their caption"}
                  </span>
                  <RelativeTime value={new Date(m.mentionedAt ?? m.receivedAt).toISOString()} />
                  {m.replyStatus === "SENT" && <Badge variant="secondary">Replied</Badge>}
                  {m.replyStatus === "UNCONFIRMED" && (
                    <Badge variant="outline" className="border-amber-500/60 text-amber-700 dark:text-amber-400">
                      Reply not confirmed
                    </Badge>
                  )}
                  {m.dismissedAt && <Badge variant="outline">Dismissed</Badge>}
                </div>

                {m.text ? (
                  <p className="whitespace-pre-wrap break-words text-sm">{m.text}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {m.detailsError ?? "Loading what they said…"}{" "}
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 underline"
                      disabled={isBusy}
                      onClick={() => refresh.mutate({ mentionId: m.id })}
                    >
                      <RefreshCw className="h-3 w-3" /> Load again
                    </button>
                  </p>
                )}

                {m.replyText && (
                  <p className="border-l-2 pl-2 text-xs text-muted-foreground">
                    Your reply: <span className="text-foreground">{m.replyText}</span>
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {m.permalink && (
                    <a
                      href={m.permalink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs underline hover:text-primary"
                    >
                      <ExternalLink className="h-3 w-3" /> View post
                    </a>
                  )}
                  {replyingTo !== m.id && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2.5 text-xs"
                      disabled={!canWrite}
                      title={writeReason}
                      onClick={() => setReplyingTo(m.id)}
                    >
                      {m.replyStatus ? "Reply again" : "Reply"}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => dismiss.mutate({ mentionId: m.id, dismissed: !m.dismissedAt })}
                  >
                    {m.dismissedAt ? "Restore" : "Dismiss"}
                  </Button>
                </div>

                {replyingTo === m.id && (
                  <div className="space-y-1.5">
                    <Textarea
                      autoFocus
                      value={draft}
                      maxLength={REPLY_MAX}
                      rows={2}
                      className="text-sm"
                      placeholder={`Reply on @${m.username ?? "their"} post as ${m.account?.name ?? "your account"}…`}
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [m.id]: e.target.value }))}
                    />
                    {m.replyStatus === "UNCONFIRMED" && (
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        An earlier reply here may already be live. Check the post on Instagram before sending again.
                      </p>
                    )}
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        className="h-7 px-3 text-xs"
                        disabled={!canWrite || isBusy || !draft.trim()}
                        onClick={() =>
                          reply.mutate({ mentionId: m.id, message: draft.trim(), again: m.replyStatus ? true : undefined })
                        }
                      >
                        {isBusy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                        {m.replyStatus === "UNCONFIRMED" ? "Send again anyway" : "Send reply"}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setReplyingTo(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {query.hasNextPage && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Load more
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
