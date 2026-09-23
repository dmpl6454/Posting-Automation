"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import {
  ExternalLink,
  Eye,
  EyeOff,
  Heart,
  Loader2,
  MessageCircle,
  Pencil,
  RefreshCw,
  ShieldAlert,
  ThumbsUp,
  Trash2,
} from "lucide-react";
import type { CommentModerationAction, SocialComment } from "@postautomation/social";
import { trpc } from "~/lib/trpc/client";
import { humanizeError } from "~/lib/errors";
import { parseGraphTimestamp } from "~/lib/graph-time";
import { classifyReplyFailure } from "~/lib/comment-reply-outcome";
import { useToast } from "~/hooks/use-toast";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import { Skeleton } from "~/components/ui/skeleton";
import { ConfirmDialog } from "~/components/ui/confirm-dialog";
import { ChannelAvatar } from "~/components/channel-avatar";
import { FacebookIcon, InstagramIcon } from "~/components/icons/platform-icons";
import { cn } from "~/lib/utils";

export type CommentPlatform = "FACEBOOK" | "INSTAGRAM";

export const PLATFORM_NAME: Record<CommentPlatform, string> = {
  FACEBOOK: "Facebook",
  INSTAGRAM: "Instagram",
};

export const ACCOUNT_KIND: Record<CommentPlatform, string> = {
  FACEBOOK: "Facebook Page",
  INSTAGRAM: "Instagram account",
};

const MODERATION_TOAST: Record<CommentModerationAction, string> = {
  hide: "Comment hidden",
  unhide: "Comment unhidden",
  delete: "Comment deleted",
  like: "Liked as the Page",
  unlike: "Like removed",
  edit: "Comment updated",
};

/** Which permission unlocks writes, per platform — shown in the reconnect banner. */
const WRITE_SCOPE: Record<CommentPlatform, string> = {
  FACEBOOK: "pages_manage_engagement",
  INSTAGRAM: "instagram_manage_comments",
};

/** Mirrors the server ceilings (FB_COMMENT_MAX_LENGTH / COMMENT_REPLY_MAX_LENGTH). */
export const REPLY_MAX_LENGTH: Record<CommentPlatform, number> = {
  FACEBOOK: 8000,
  INSTAGRAM: 2200,
};

export function PlatformGlyph({ platform, className }: { platform: CommentPlatform; className?: string }) {
  return platform === "FACEBOOK" ? (
    <FacebookIcon className={className} size={14} />
  ) : (
    <InstagramIcon className={className} size={14} />
  );
}

function attachmentLabel(type: string | null): string | null {
  if (!type) return null;
  if (type === "photo") return "Photo";
  if (type === "sticker") return "Sticker";
  if (type.startsWith("animated_image")) return "GIF";
  if (type.startsWith("video")) return "Video";
  return "Attachment";
}

function authorLabel(c: SocialComment, platform: CommentPlatform, namesHidden: boolean): string {
  if (platform === "INSTAGRAM") {
    if (c.author.username) return `@${c.author.username}`;
    // Meta withholds commenter usernames unless the token holds
    // instagram_manage_comments (since 2024-08-27). Say WHY, so "Instagram user"
    // doesn't read as a bug when several people comment.
    return namesHidden ? "Instagram user (name hidden)" : "Instagram user";
  }
  // Meta withholds the commenter's identity in some cases (privacy settings,
  // deleted profiles) — say so plainly rather than inventing a name.
  return c.author.name ?? "Facebook user";
}

function RelativeTime({ value }: { value: string }) {
  const d = parseGraphTimestamp(value);
  if (!d) return null;
  // Clock skew between Meta and the viewer's device can put a just-posted
  // reply a few seconds in the "future" — "in 1 minute" reads as a bug.
  const shown = d.getTime() > Date.now() ? new Date() : d;
  return (
    <time dateTime={d.toISOString()} title={d.toLocaleString()} className="text-[11px] text-muted-foreground">
      {formatDistanceToNow(shown, { addSuffix: true })}
    </time>
  );
}

interface CommentThreadProps {
  targetId: string;
  /** Known before the first load (from the post/account) — the header renders immediately. */
  platform?: CommentPlatform;
  accountName?: string;
  accountAvatar?: string | null;
  /** The post's public URL — "Open on Facebook/Instagram" and "more replies" links. */
  publishedUrl?: string | null;
  className?: string;
}

/**
 * Live comment thread for ONE published post, with reply-as-the-Page.
 *
 * Every open/refresh is a live Graph read (nothing is cached server-side), so
 * the header says so — which is also the "live retrieval of user content,
 * displayed with the Page clearly labeled" Meta's App Review asks to see.
 */
export function CommentThread({
  targetId,
  platform: platformProp,
  accountName: accountNameProp,
  accountAvatar: accountAvatarProp,
  publishedUrl: publishedUrlProp,
  className,
}: CommentThreadProps) {
  const { toast } = useToast();
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Comments whose last reply attempt has an UNKNOWN outcome (it may be live).
  // The composer stays open with a warning and an explicit "send again anyway".
  const [unconfirmed, setUnconfirmed] = useState<Record<string, boolean>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<SocialComment | null>(null);

  const query = trpc.comment.list.useInfiniteQuery(
    { targetId },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      // Each fetch is a live Graph call against the Page's rate budget; the
      // errors worth showing (permission, dead token) are deterministic, so
      // retrying them only burns quota.
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    }
  );

  const first = query.data?.pages[0];
  // Never GUESS the platform: an Instagram thread labelled "Facebook Page"
  // (while loading, or forever if the load fails) is exactly the identity
  // confusion the header exists to prevent.
  const knownPlatform = (first?.platform as CommentPlatform | undefined) ?? platformProp ?? null;
  const platform: CommentPlatform = knownPlatform ?? "INSTAGRAM"; // only used once knownPlatform is set
  const accountName = first?.account.name ?? accountNameProp ?? (knownPlatform ? ACCOUNT_KIND[knownPlatform] : "Loading account…");
  const accountAvatar = first?.account.avatar ?? accountAvatarProp ?? null;
  const publishedUrl = first?.publishedUrl ?? publishedUrlProp ?? null;
  // Instagram's (lower) ceiling until the platform is known.
  const maxLength = knownPlatform ? REPLY_MAX_LENGTH[knownPlatform] : REPLY_MAX_LENGTH.INSTAGRAM;

  // Cursor pages never overlap in principle; de-dupe anyway so a comment that
  // shifts across a page boundary between fetches can't render twice.
  const comments = useMemo(() => {
    const seen = new Set<string>();
    const out: SocialComment[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const c of page.comments as SocialComment[]) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
      }
    }
    return out;
  }, [query.data]);

  const reply = trpc.comment.reply.useMutation({
    onSuccess: (_res, variables) => {
      toast({ title: `Reply posted as ${accountName}` });
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[variables.commentId];
        return next;
      });
      setUnconfirmed((prev) => {
        const next = { ...prev };
        delete next[variables.commentId];
        return next;
      });
      setReplyingTo(null);
      void query.refetch();
    },
    onError: (err, variables) => {
      if (classifyReplyFailure(err as any) === "unconfirmed") {
        // Creating a reply is NOT idempotent: an unknown outcome must never read
        // as a plain failure with the same draft one click from being re-sent.
        toast({
          title: "Reply not confirmed",
          description: "It may already be posted — check the thread before sending it again.",
        });
        setUnconfirmed((prev) => ({ ...prev, [variables.commentId]: true }));
        void query.refetch();
        return;
      }
      toast({ title: "Couldn't send reply", description: humanizeError(err), variant: "destructive" });
    },
  });

  // What this channel's token may actually do (granted scopes, checked at
  // connect or lazily on first open). `false` = known missing → the UI shows
  // WHY and how to fix it instead of letting an action fail or hiding it.
  const caps = first?.capabilities;
  const writeBlocked = caps?.known === true && caps.canReply === false;
  const namesHidden = caps?.namesHidden === true;
  const blockedTitle = knownPlatform
    ? `Needs the ${WRITE_SCOPE[knownPlatform]} permission — reconnect this ${knownPlatform === "FACEBOOK" ? "Page" : "account"} on the Channels page`
    : undefined;

  const moderate = trpc.comment.moderate.useMutation({
    onSuccess: (_res, variables) => {
      toast({ title: MODERATION_TOAST[variables.action] });
      if (variables.action === "edit") setEditingId(null);
      if (variables.action === "delete") setPendingDelete(null);
      void query.refetch();
    },
    onError: (err, variables) => {
      toast({ title: "Couldn't update the comment", description: humanizeError(err), variant: "destructive" });
      if (variables.action === "delete") setPendingDelete(null);
      // These are idempotent — just show the real state.
      void query.refetch();
    },
  });
  const runAction = (comment: SocialComment, action: CommentModerationAction, message?: string) =>
    moderate.mutate({ targetId, commentId: comment.id, action, message });
  const actionBusy = (id: string) => moderate.isPending && moderate.variables?.commentId === id;

  const send = (commentId: string) => {
    const message = (drafts[commentId] ?? "").trim();
    if (!message || reply.isPending) return;
    reply.mutate({ targetId, commentId, message });
  };

  const renderComment = (c: SocialComment, isReply: boolean) => {
    const draft = drafts[c.id] ?? "";
    const attachment = attachmentLabel(c.attachmentType);
    return (
      <div key={c.id} className={cn("space-y-1", isReply ? "border-l-2 pl-3" : "")}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-xs font-semibold">{authorLabel(c, platform, namesHidden)}</span>
          {c.isOwn && (
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]" title={`Written by ${accountName}`}>
              {platform === "FACEBOOK" ? "Page" : "You"}
            </Badge>
          )}
          {c.hidden && (
            <Badge
              variant="outline"
              className="h-4 gap-1 px-1.5 text-[10px]"
              title="Hidden on the platform — only you and the commenter can see it"
            >
              <EyeOff className="h-2.5 w-2.5" /> Hidden
            </Badge>
          )}
          <RelativeTime value={c.createdAt} />
        </div>
        {editingId === c.id ? (
          <div className="space-y-1.5">
            <Textarea
              autoFocus
              value={editDraft}
              maxLength={maxLength}
              rows={2}
              className="text-sm"
              onChange={(e) => setEditDraft(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="h-7 px-3 text-xs"
                disabled={actionBusy(c.id) || !editDraft.trim() || editDraft.trim() === c.text}
                onClick={() => runAction(c, "edit", editDraft.trim())}
                title={`Save the new text of ${accountName}'s comment on Facebook`}
              >
                {actionBusy(c.id) && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                Save edit
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditingId(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : c.text ? (
          <p className="whitespace-pre-wrap break-words text-sm">{c.text}</p>
        ) : attachment ? (
          <p className="text-sm italic text-muted-foreground">[{attachment}]</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {c.likeCount > 0 && (
            <span className="inline-flex items-center gap-1" title="Likes">
              <Heart className="h-3 w-3" /> {c.likeCount}
            </span>
          )}
          {/* Reply stays VISIBLE (disabled, with the reason) when the token lacks
              the permission — Facebook reports can_comment=false in that case,
              which used to make the button silently disappear. */}
          {replyingTo !== c.id && (c.canReply || (writeBlocked && !isReply && !c.hidden)) && (
            <button
              type="button"
              className="font-medium hover:text-primary hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50"
              title={writeBlocked ? blockedTitle : `Reply publicly as ${accountName}`}
              disabled={writeBlocked}
              onClick={() => setReplyingTo(c.id)}
            >
              Reply
            </button>
          )}
          {c.canLike && (
            <button
              type="button"
              className="inline-flex items-center gap-1 font-medium hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
              title={writeBlocked ? blockedTitle : c.likedByAccount ? "Remove the Page's like" : `Like as ${accountName}`}
              disabled={writeBlocked || actionBusy(c.id)}
              onClick={() => runAction(c, c.likedByAccount ? "unlike" : "like")}
            >
              <ThumbsUp className={cn("h-3 w-3", c.likedByAccount && "fill-current text-primary")} />
              {c.likedByAccount ? "Liked" : "Like"}
            </button>
          )}
          {c.canHide && (
            <button
              type="button"
              className="inline-flex items-center gap-1 font-medium hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
              title={
                writeBlocked
                  ? blockedTitle
                  : c.hidden
                    ? "Show this comment to everyone again"
                    : "Hide from everyone except the commenter and their friends"
              }
              disabled={writeBlocked || actionBusy(c.id)}
              onClick={() => runAction(c, c.hidden ? "unhide" : "hide")}
            >
              {c.hidden ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              {c.hidden ? "Unhide" : "Hide"}
            </button>
          )}
          {c.canEdit && editingId !== c.id && (
            <button
              type="button"
              className="inline-flex items-center gap-1 font-medium hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
              title={writeBlocked ? blockedTitle : `Edit ${accountName}'s comment`}
              disabled={writeBlocked || actionBusy(c.id)}
              onClick={() => {
                setEditDraft(c.text);
                setEditingId(c.id);
              }}
            >
              <Pencil className="h-3 w-3" /> Edit
            </button>
          )}
          {c.canDelete && (
            <button
              type="button"
              className="inline-flex items-center gap-1 font-medium hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
              title={writeBlocked ? blockedTitle : `Delete this comment from ${PLATFORM_NAME[platform]}`}
              disabled={writeBlocked || actionBusy(c.id)}
              onClick={() => setPendingDelete(c)}
            >
              <Trash2 className="h-3 w-3" /> Delete
            </button>
          )}
          {actionBusy(c.id) && <Loader2 className="h-3 w-3 animate-spin" />}
        </div>

        {c.canReply && !writeBlocked && replyingTo === c.id && (
          <div className="space-y-1.5 pt-1">
            {unconfirmed[c.id] && (
              <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-400">
                Your last reply to this comment may already be posted — check the replies below
                {publishedUrl ? " or on the post itself" : ""} before sending it again.
              </p>
            )}
            <Textarea
              autoFocus
              value={draft}
              maxLength={maxLength}
              rows={2}
              placeholder={`Reply as ${accountName}…`}
              className="text-sm"
              onChange={(e) => setDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  send(c.id);
                }
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                className="h-7 min-w-0 max-w-full px-3 text-xs"
                disabled={reply.isPending || !draft.trim()}
                onClick={() => send(c.id)}
                title={`Post this reply publicly on ${PLATFORM_NAME[platform]} as ${accountName} (Ctrl/⌘+Enter)`}
              >
                {reply.isPending && reply.variables?.commentId === c.id && (
                  <Loader2 className="mr-1 h-3 w-3 shrink-0 animate-spin" />
                )}
                {/* Long Page names truncate instead of overflowing the column. */}
                <span className="min-w-0 truncate">
                  {unconfirmed[c.id] ? "Send again anyway" : `Reply as ${accountName}`}
                </span>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                disabled={reply.isPending}
                onClick={() => setReplyingTo(null)}
              >
                Cancel
              </Button>
              <span className="ml-auto text-[10px] text-muted-foreground">
                {draft.length.toLocaleString()}/{maxLength.toLocaleString()}
              </span>
            </div>
          </div>
        )}

        {!isReply && c.replies.length > 0 && (
          <div className="space-y-3 pt-2">{c.replies.map((r) => renderComment(r, true))}</div>
        )}
        {!isReply && c.replyCount > c.replies.length && (
          <p className="pt-1 text-[11px] text-muted-foreground">
            {c.replyCount - c.replies.length} more{" "}
            {c.replyCount - c.replies.length === 1 ? "reply" : "replies"}
            {publishedUrl ? (
              <>
                {" "}—{" "}
                <a href={publishedUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-primary">
                  view on {PLATFORM_NAME[platform]}
                </a>
              </>
            ) : (
              ` on ${PLATFORM_NAME[platform]}`
            )}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className={cn("space-y-3", className)}>
      {/* Identity header — which Page/account these comments belong to and who
          a reply will be posted as. */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 p-2.5">
        <ChannelAvatar avatar={accountAvatar} name={accountName} className="h-8 w-8 shrink-0" />
        {/* basis-48: below ~12rem of room the buttons wrap to their own row
            instead of squeezing the Page's name to a few characters (phones). */}
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium">
            {knownPlatform && <PlatformGlyph platform={knownPlatform} className="shrink-0" />}
            <span className="truncate">{accountName}</span>
          </p>
          <p className="text-[11px] text-muted-foreground">
            {knownPlatform
              ? `${ACCOUNT_KIND[knownPlatform]} · live from ${PLATFORM_NAME[knownPlatform]} · replies post publicly as this ${
                  knownPlatform === "FACEBOOK" ? "Page" : "account"
                }`
              : "Comments load live from Facebook or Instagram"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            title={`Fetch the latest comments from ${knownPlatform ? PLATFORM_NAME[knownPlatform] : "the platform"}`}
          >
            <RefreshCw className={cn("mr-1 h-3 w-3", query.isFetching && "animate-spin")} />
            Refresh
          </Button>
          {publishedUrl && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" asChild>
              <a
                href={publishedUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open this post on ${knownPlatform ? PLATFORM_NAME[knownPlatform] : "the platform"}`}
              >
                Open <ExternalLink className="ml-1 h-3 w-3" />
              </a>
            </Button>
          )}
        </div>
      </div>

      {knownPlatform && (writeBlocked || namesHidden) && (
        // The permission picture, in words: which scope is missing and exactly
        // how to fix it. Without this, a missing grant looked like a broken
        // button ("no Reply on Facebook") or a bug ("Instagram user").
        <div className="flex gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-300">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">
              {knownPlatform === "FACEBOOK"
                ? "Replying and moderating are off for this Page."
                : "Commenter names are hidden and replying/moderating is off for this account."}
            </p>
            <p>
              Its connection doesn't include <code className="font-mono">{WRITE_SCOPE[knownPlatform]}</code> — it was
              connected before PostAutomation asked for it, or Meta hasn't approved it for this account yet. Reconnect:
              Channels → Connect {PLATFORM_NAME[knownPlatform]} → <strong>Edit settings</strong> → keep this{" "}
              {knownPlatform === "FACEBOOK" ? "Page" : "account's Page"} ticked → allow every permission.
            </p>
            <Link href="/dashboard/channels" className="inline-block font-medium underline">
              Go to Channels
            </Link>
          </div>
        </div>
      )}

      {query.isLoading ? (
        <div className="space-y-3" aria-label="Loading comments">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-4 w-full" />
            </div>
          ))}
        </div>
      ) : query.isError && !query.data ? (
        // Full-panel error ONLY when nothing is loaded yet. A failed refresh or
        // "load more" must not wipe a loaded thread (or an open reply draft).
        <div className="space-y-2 rounded-md border border-destructive/40 p-3">
          <p className="text-sm text-destructive">{humanizeError(query.error)}</p>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : comments.length === 0 ? (
        (first?.totalCount ?? 0) > 0 ? (
          // Meta counts comments it will not list (privacy settings, deleted or
          // restricted accounts). "No comments yet" would contradict its count.
          <p className="flex items-start gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            <MessageCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {PLATFORM_NAME[platform]} reports {first!.totalCount!.toLocaleString()}{" "}
              {first!.totalCount === 1 ? "comment" : "comments"} on this post, but none can be shown here right now
              (privacy settings or deleted comments).
              {publishedUrl && (
                <>
                  {" "}
                  <a href={publishedUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-primary">
                    View the post
                  </a>
                  .
                </>
              )}
            </span>
          </p>
        ) : (
          <p className="flex items-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            <MessageCircle className="h-4 w-4" /> No comments on this post yet.
          </p>
        )
      ) : (
        <>
          {query.isRefetchError && (
            <p className="text-xs text-destructive">Couldn't refresh: {humanizeError(query.error)}</p>
          )}
          {/* Facebook's summary.total_count with filter=toplevel counts
              TOP-LEVEL comments only (replies excluded), and can exceed what is
              listable because of privacy/deletion — say exactly that. */}
          {typeof first?.totalCount === "number" && (
            <p className="text-xs text-muted-foreground">
              {first.totalCount.toLocaleString()} top-level {first.totalCount === 1 ? "comment" : "comments"} on{" "}
              {PLATFORM_NAME[platform]}
              {first.totalCount > comments.length ? ` · showing ${comments.length.toLocaleString()}` : ""}
            </p>
          )}
          <div className="space-y-4">{comments.map((c) => renderComment(c, false))}</div>
          {query.isFetchNextPageError && (
            <p className="text-xs text-destructive">Couldn't load more: {humanizeError(query.error)}</p>
          )}
          {query.hasNextPage && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 w-full text-xs"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              {query.isFetchNextPageError ? "Try loading more again" : "Load more comments"}
            </Button>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete this comment?"
        description={`It will be removed from ${knownPlatform ? PLATFORM_NAME[knownPlatform] : "the platform"} for everyone. This can't be undone.`}
        confirmLabel="Delete"
        isPending={!!pendingDelete && actionBusy(pendingDelete.id)}
        onConfirm={() => pendingDelete && runAction(pendingDelete, "delete")}
      />
    </div>
  );
}
