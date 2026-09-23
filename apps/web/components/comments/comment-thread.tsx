"use client";

import { useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  ExternalLink,
  EyeOff,
  Heart,
  Loader2,
  MessageCircle,
  RefreshCw,
} from "lucide-react";
import type { SocialComment } from "@postautomation/social";
import { trpc } from "~/lib/trpc/client";
import { humanizeError } from "~/lib/errors";
import { parseGraphTimestamp } from "~/lib/graph-time";
import { useToast } from "~/hooks/use-toast";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Textarea } from "~/components/ui/textarea";
import { Skeleton } from "~/components/ui/skeleton";
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

/** Mirrors the server ceilings (FB_COMMENT_MAX_LENGTH / COMMENT_REPLY_MAX_LENGTH). */
export const REPLY_MAX_LENGTH: Record<CommentPlatform, number> = {
  FACEBOOK: 8000,
  INSTAGRAM: 2200,
};

/** The provider's "outcome unknown" wording — the reply may already be live. */
const UNCONFIRMED_RE = /may already be posted/i;

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

function authorLabel(c: SocialComment, platform: CommentPlatform): string {
  if (platform === "INSTAGRAM") return c.author.username ? `@${c.author.username}` : "Instagram user";
  // Meta withholds the commenter's identity in some cases (privacy settings,
  // deleted profiles) — say so plainly rather than inventing a name.
  return c.author.name ?? "Facebook user";
}

function RelativeTime({ value }: { value: string }) {
  const d = parseGraphTimestamp(value);
  if (!d) return null;
  return (
    <time dateTime={d.toISOString()} title={d.toLocaleString()} className="text-[11px] text-muted-foreground">
      {formatDistanceToNow(d, { addSuffix: true })}
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
  const platform: CommentPlatform = (first?.platform as CommentPlatform | undefined) ?? platformProp ?? "FACEBOOK";
  const accountName = first?.account.name ?? accountNameProp ?? ACCOUNT_KIND[platform];
  const accountAvatar = first?.account.avatar ?? accountAvatarProp ?? null;
  const publishedUrl = first?.publishedUrl ?? publishedUrlProp ?? null;
  const maxLength = REPLY_MAX_LENGTH[platform];

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
      setReplyingTo(null);
      void query.refetch();
    },
    onError: (err) => {
      toast({ title: "Couldn't send reply", description: humanizeError(err), variant: "destructive" });
      // The reply may be live — show the thread's real state before the user
      // decides whether to send it again.
      if (UNCONFIRMED_RE.test(err.message)) void query.refetch();
    },
  });

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
          <span className="text-xs font-semibold">{authorLabel(c, platform)}</span>
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
        {c.text ? (
          <p className="whitespace-pre-wrap break-words text-sm">{c.text}</p>
        ) : attachment ? (
          <p className="text-sm italic text-muted-foreground">[{attachment}]</p>
        ) : null}
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          {c.likeCount > 0 && (
            <span className="inline-flex items-center gap-1" title="Likes">
              <Heart className="h-3 w-3" /> {c.likeCount}
            </span>
          )}
          {c.canReply && replyingTo !== c.id && (
            <button
              type="button"
              className="font-medium hover:text-primary hover:underline"
              title={`Reply publicly as ${accountName}`}
              onClick={() => setReplyingTo(c.id)}
            >
              Reply
            </button>
          )}
        </div>

        {c.canReply && replyingTo === c.id && (
          <div className="space-y-1.5 pt-1">
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
                className="h-7 px-3 text-xs"
                disabled={reply.isPending || !draft.trim()}
                onClick={() => send(c.id)}
                title={`Post this reply publicly on ${PLATFORM_NAME[platform]} as ${accountName} (Ctrl/⌘+Enter)`}
              >
                {reply.isPending && reply.variables?.commentId === c.id && (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                )}
                Reply as {accountName}
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
        <ChannelAvatar avatar={accountAvatar} name={accountName} className="h-8 w-8" />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium">
            <PlatformGlyph platform={platform} className="shrink-0" />
            <span className="truncate">{accountName}</span>
          </p>
          <p className="text-[11px] text-muted-foreground">
            {ACCOUNT_KIND[platform]} · comments load live from {PLATFORM_NAME[platform]} · replies post publicly as this{" "}
            {platform === "FACEBOOK" ? "Page" : "account"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            title={`Fetch the latest comments from ${PLATFORM_NAME[platform]}`}
          >
            <RefreshCw className={cn("mr-1 h-3 w-3", query.isFetching && "animate-spin")} />
            Refresh
          </Button>
          {publishedUrl && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" asChild>
              <a href={publishedUrl} target="_blank" rel="noopener noreferrer" title={`Open this post on ${PLATFORM_NAME[platform]}`}>
                Open <ExternalLink className="ml-1 h-3 w-3" />
              </a>
            </Button>
          )}
        </div>
      </div>

      {query.isLoading ? (
        <div className="space-y-3" aria-label="Loading comments">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-4 w-full" />
            </div>
          ))}
        </div>
      ) : query.isError ? (
        <div className="space-y-2 rounded-md border border-destructive/40 p-3">
          <p className="text-sm text-destructive">{humanizeError(query.error)}</p>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : comments.length === 0 ? (
        <p className="flex items-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          <MessageCircle className="h-4 w-4" /> No comments on this post yet.
        </p>
      ) : (
        <>
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
          {query.hasNextPage && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 w-full text-xs"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              Load more comments
            </Button>
          )}
        </>
      )}
    </div>
  );
}
