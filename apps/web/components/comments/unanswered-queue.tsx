"use client";

import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { CheckCheck, ImageIcon, Inbox, Loader2, MessageCircle, RefreshCw, Sparkles, Undo2, Video } from "lucide-react";
import type { SocialComment } from "@postautomation/social";
import { trpc } from "~/lib/trpc/client";
import { humanizeError } from "~/lib/errors";
import { classifyReplyFailure } from "~/lib/comment-reply-outcome";
import { addDone, QUEUE_WINDOWS, readDoneMap, removeDone, writeDoneMap, type DoneMap } from "~/lib/comment-queue";
import { useToast } from "~/hooks/use-toast";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import { Skeleton } from "~/components/ui/skeleton";
import { ChannelAvatar } from "~/components/channel-avatar";
import {
  ACCOUNT_KIND,
  PLATFORM_NAME,
  PlatformGlyph,
  REPLY_MAX_LENGTH,
  RelativeTime,
  authorLabel,
  type CommentPlatform,
} from "~/components/comments/comment-thread";
import { cn } from "~/lib/utils";

/**
 * Unanswered comments queue (2026-10-05).
 *
 * Every top-level comment on the org's recent Facebook/Instagram posts that
 * nobody on the Page/account has replied to yet, newest posts first, read live
 * from Meta on each load (comment.unanswered — budgeted server-side). Reply in
 * place (optionally from an AI draft a person edits and sends), or mark a
 * comment Done in this browser when it needs no reply.
 *
 * Loads ONLY while this tab is open — like opening a thread, it is a set of
 * live Graph reads and should happen because someone asked.
 */

interface Account {
  id: string;
  name: string;
  platform: string;
}

interface QueueProps {
  accounts: Account[];
  onOpenThread: (channelId: string, targetId: string) => void;
}

const MAX_POSTS = 12;

export function UnansweredQueue({ accounts, onOpenThread }: QueueProps) {
  const { toast } = useToast();
  const [days, setDays] = useState<number>(7);
  const [channelId, setChannelId] = useState<string>("");
  const [done, setDone] = useState<DoneMap>({});
  const [showDone, setShowDone] = useState(false);
  // Comments answered in this session — removed from the list at once, without
  // re-reading every post from Meta.
  const [answered, setAnswered] = useState<Set<string>>(() => new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [unconfirmed, setUnconfirmed] = useState<Record<string, boolean>>({});
  const [draftingId, setDraftingId] = useState<string | null>(null);

  useEffect(() => setDone(readDoneMap()), []);
  const updateDone = (next: DoneMap) => {
    setDone(next);
    writeDoneMap(next);
  };

  const query = trpc.comment.unanswered.useQuery(
    { days, maxPosts: MAX_POSTS, ...(channelId ? { channelId } : {}) },
    {
      // Each load is up to MAX_POSTS live Graph reads; errors worth showing are
      // deterministic, so a retry only burns the Pages' quota.
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 2 * 60_000,
    }
  );

  const reply = trpc.comment.reply.useMutation({
    onSuccess: (_res, v) => {
      setAnswered((prev) => new Set(prev).add(v.commentId));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[v.commentId];
        return next;
      });
      setUnconfirmed((prev) => {
        const next = { ...prev };
        delete next[v.commentId];
        return next;
      });
      setOpenId(null);
      toast({ title: "Reply posted" });
    },
    onError: (err, v) => {
      if (classifyReplyFailure(err as any) === "unconfirmed") {
        toast({
          title: "Reply not confirmed",
          description: "It may already be posted — open the post's thread and check before sending again.",
        });
        setUnconfirmed((prev) => ({ ...prev, [v.commentId]: true }));
        return;
      }
      toast({ title: "Couldn't send reply", description: humanizeError(err), variant: "destructive" });
    },
  });

  const suggest = trpc.comment.suggestReply.useMutation({
    onSettled: () => setDraftingId(null),
    onError: (err) => toast({ title: "Couldn't draft a reply", description: humanizeError(err), variant: "destructive" }),
  });

  const draftWithAi = (targetId: string, c: SocialComment) => {
    setDraftingId(c.id);
    suggest.mutate(
      { targetId, commentText: c.text || "(a comment with no text)" },
      { onSuccess: (res) => setDrafts((prev) => ({ ...prev, [c.id]: res.draft })) }
    );
  };

  const posts = useMemo(() => query.data?.posts ?? [], [query.data]);
  const visible = useMemo(
    () =>
      posts.map((p) => ({
        ...p,
        items: p.unanswered.filter(
          (u) => !answered.has(u.comment.id) && (showDone || !(u.comment.id in done))
        ),
      })),
    [posts, answered, done, showDone]
  );
  const remaining = visible.reduce((n, p) => n + p.items.filter((u) => !(u.comment.id in done)).length, 0);
  const doneHere = posts.reduce((n, p) => n + p.unanswered.filter((u) => u.comment.id in done).length, 0);
  const problems = posts.filter((p) => p.status !== "ok");

  return (
    <div className="space-y-3" data-testid="unanswered-queue">
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2.5">
        <Inbox className="h-4 w-4 shrink-0 text-muted-foreground" />
        <label className="flex items-center gap-1.5 text-xs">
          Posts from the last
          <select
            className="h-7 rounded-md border bg-background px-1.5 text-xs"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            aria-label="Window in days"
          >
            {QUEUE_WINDOWS.map((d) => (
              <option key={d} value={d}>
                {d === 1 ? "24 hours" : `${d} days`}
              </option>
            ))}
          </select>
        </label>
        <select
          className="h-7 max-w-[14rem] rounded-md border bg-background px-1.5 text-xs"
          value={channelId}
          onChange={(e) => setChannelId(e.target.value)}
          aria-label="Account"
        >
          <option value="">All Pages and accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.platform === "FACEBOOK" ? "Facebook" : "Instagram"} · {a.name}
            </option>
          ))}
        </select>
        {doneHere > 0 && (
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
            Show done ({doneHere})
          </label>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-7 px-2 text-xs"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          title="Check the posts again, live from Facebook and Instagram"
        >
          <RefreshCw className={cn("mr-1 h-3 w-3", query.isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {query.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
          <p className="text-xs text-muted-foreground">Checking your recent posts on Facebook and Instagram…</p>
        </div>
      ) : query.isError ? (
        <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{humanizeError(query.error)}</p>
      ) : posts.length === 0 ? (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Nothing published to Facebook or Instagram through PostAutomation in this window. Widen it, or pick another
          account.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground" data-testid="queue-summary">
            {remaining === 0
              ? `All caught up — no unanswered comments on ${posts.length} ${posts.length === 1 ? "post" : "posts"} checked.`
              : `${remaining} unanswered ${remaining === 1 ? "comment" : "comments"} on ${posts.length} ${
                  posts.length === 1 ? "post" : "posts"
                } checked.`}{" "}
            {query.data?.morePosts &&
              `Only the ${MAX_POSTS} newest posts in this window were checked — pick an account or a shorter window to see the rest.`}
          </p>

          {problems.length > 0 && (
            <ul className="space-y-1 rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-[11px] text-amber-800 dark:text-amber-300">
              {problems.map((p) => (
                <li key={p.targetId}>
                  <span className="font-medium">{p.channel?.name ?? "A post"}</span>
                  {p.caption ? ` — “${p.caption.slice(0, 60)}${p.caption.length > 60 ? "…" : ""}”` : ""}:{" "}
                  {p.status === "busy"
                    ? "skipped — lots of comment activity on this Page right now. Refresh in a minute."
                    : p.error}
                </li>
              ))}
            </ul>
          )}

          {visible
            .filter((p) => p.items.length > 0)
            .map((p) => {
              const platform = (p.channel?.platform ?? "INSTAGRAM") as CommentPlatform;
              const namesHidden = p.capabilities?.namesHidden === true;
              const writeBlocked = p.capabilities?.known === true && p.capabilities.canReply === false;
              return (
                <div key={p.targetId} className="space-y-2 rounded-md border p-3" data-testid="queue-post">
                  <div className="flex items-start gap-2.5">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                      {/* Only an IMAGE url ever reaches <img> — never a video file. */}
                      {p.thumbnailUrl ? (
                        <img src={p.thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                      ) : p.mediaKind === "video" ? (
                        <Video className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ImageIcon className="h-4 w-4 text-muted-foreground" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 text-xs font-medium">
                        {p.channel && <ChannelAvatar avatar={p.channel.avatar} name={p.channel.name} className="h-4 w-4" />}
                        <PlatformGlyph platform={platform} className="shrink-0" />
                        <span className="truncate">{p.channel?.name ?? ACCOUNT_KIND[platform]}</span>
                        <span className="shrink-0 font-normal text-muted-foreground">
                          · {p.publishedAt ? format(new Date(p.publishedAt), "d MMM, HH:mm") : "published"}
                        </span>
                      </p>
                      <p className="line-clamp-1 text-[11px] text-muted-foreground">
                        {p.caption || <em>No caption</em>}
                      </p>
                    </div>
                    {p.channel && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 shrink-0 px-2 text-xs"
                        onClick={() => onOpenThread(p.channel!.id, p.targetId)}
                        title="Open this post's full comment thread"
                      >
                        <MessageCircle className="mr-1 h-3 w-3" /> Thread
                      </Button>
                    )}
                  </div>

                  {writeBlocked && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-400">
                      Replying is off for this {platform === "FACEBOOK" ? "Page" : "account"} — reconnect it on the
                      Channels page (Edit settings, allow every permission).
                    </p>
                  )}

                  <ul className="space-y-2">
                    {p.items.map(({ comment: c, repliesPartial }) => {
                      const isDone = c.id in done;
                      const open = openId === c.id;
                      const draft = drafts[c.id] ?? "";
                      const max = REPLY_MAX_LENGTH[platform];
                      const sending = reply.isPending && reply.variables?.commentId === c.id;
                      const canReply = !writeBlocked && c.canReply;
                      return (
                        <li key={c.id} className={cn("rounded-md bg-muted/40 p-2", isDone && "opacity-60")} data-testid="queue-item">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="text-xs font-semibold">{authorLabel(c, platform, namesHidden)}</span>
                            <RelativeTime value={c.createdAt} />
                            {c.replyCount > 0 && (
                              <Badge variant="outline" className="h-4 px-1.5 text-[10px]" title="Replies from other people">
                                {c.replyCount} {c.replyCount === 1 ? "reply" : "replies"} from others
                              </Badge>
                            )}
                            {repliesPartial && (
                              <Badge
                                variant="outline"
                                className="h-4 border-amber-500 px-1.5 text-[10px] text-amber-700 dark:text-amber-400"
                                title="This comment has more replies than were checked — an older reply of yours may be among them. Open the thread to make sure."
                              >
                                May already have a reply
                              </Badge>
                            )}
                            {isDone && (
                              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                                Done
                              </Badge>
                            )}
                          </div>
                          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm">
                            {c.text || <em className="text-muted-foreground">{c.attachmentType ? "Attachment" : "No text"}</em>}
                          </p>

                          {!open && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs"
                                disabled={!canReply}
                                onClick={() => setOpenId(c.id)}
                                title={
                                  canReply
                                    ? `Reply publicly as ${p.channel?.name ?? "this account"}`
                                    : writeBlocked
                                      ? "Replying is off for this account — reconnect it"
                                      : `${PLATFORM_NAME[platform]} doesn't allow a reply to this comment`
                                }
                              >
                                <MessageCircle className="mr-1 h-3 w-3" /> Reply
                              </Button>
                              {isDone ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => updateDone(removeDone(done, c.id))}
                                >
                                  <Undo2 className="mr-1 h-3 w-3" /> Not done
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => updateDone(addDone(done, c.id))}
                                  title="Take it off the queue without replying (remembered in this browser)"
                                >
                                  <CheckCheck className="mr-1 h-3 w-3" /> Done
                                </Button>
                              )}
                            </div>
                          )}

                          {open && (
                            <div className="mt-2 space-y-1.5">
                              {unconfirmed[c.id] && (
                                <p className="rounded border border-amber-500/50 bg-amber-500/10 p-1.5 text-[11px] text-amber-800 dark:text-amber-300">
                                  The last attempt wasn&apos;t confirmed — it may already be posted. Open the thread and
                                  check before sending again.
                                </p>
                              )}
                              <Textarea
                                autoFocus
                                rows={2}
                                value={draft}
                                maxLength={max}
                                placeholder={`Reply as ${p.channel?.name ?? "this account"}…`}
                                className="text-sm"
                                onChange={(e) => setDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim() && !reply.isPending) {
                                    reply.mutate({ targetId: p.targetId, commentId: c.id, message: draft.trim() });
                                  }
                                }}
                              />
                              <div className="flex flex-wrap items-center gap-1.5">
                                <Button
                                  size="sm"
                                  className="h-7 px-3 text-xs"
                                  disabled={!draft.trim() || reply.isPending}
                                  onClick={() => reply.mutate({ targetId: p.targetId, commentId: c.id, message: draft.trim() })}
                                  title="Post this reply publicly (Ctrl/⌘+Enter)"
                                >
                                  {sending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                                  {unconfirmed[c.id] ? "Send again anyway" : "Send reply"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs"
                                  disabled={draftingId !== null}
                                  onClick={() => draftWithAi(p.targetId, c)}
                                  title="Write a draft with AI — you can edit it before sending; nothing is posted until you click Send"
                                >
                                  {draftingId === c.id ? (
                                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                  ) : (
                                    <Sparkles className="mr-1 h-3 w-3" />
                                  )}
                                  {draft.trim() ? "Redraft with AI" : "Draft with AI"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs"
                                  disabled={reply.isPending}
                                  onClick={() => setOpenId(null)}
                                >
                                  Cancel
                                </Button>
                                <span className="ml-auto text-[10px] text-muted-foreground">
                                  {draft.length.toLocaleString()}/{max.toLocaleString()}
                                </span>
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>

                  {p.moreComments && (
                    <p className="text-[11px] text-muted-foreground">
                      Only the first page of comments on this post was checked —{" "}
                      <button
                        type="button"
                        className="underline hover:text-primary"
                        onClick={() => p.channel && onOpenThread(p.channel.id, p.targetId)}
                      >
                        open the thread
                      </button>{" "}
                      for older ones.
                    </p>
                  )}
                </div>
              );
            })}
        </>
      )}
    </div>
  );
}
