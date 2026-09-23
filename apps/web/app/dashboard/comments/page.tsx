"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { ImageIcon, Loader2, MessageSquare, Search, Video } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { humanizeError } from "~/lib/errors";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { ChannelAvatar } from "~/components/channel-avatar";
import {
  ACCOUNT_KIND,
  CommentThread,
  PlatformGlyph,
  type CommentPlatform,
} from "~/components/comments/comment-thread";
import { cn } from "~/lib/utils";

/**
 * Comments inbox (2026-09-23).
 *
 * 1. pick a Facebook Page / Instagram account  (its identity stays visible)
 * 2. pick one of the posts published to it through PostAutomation
 * 3. the comment thread loads LIVE from Meta; reply publicly as that Page/account
 *
 * Deep link: /dashboard/comments?channel=<channelId>&post=<postTargetId>
 * (the post detail page links here).
 */
export default function CommentsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <CommentsInbox />
    </Suspense>
  );
}

function CommentsInbox() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const channelParam = searchParams.get("channel");
  const postParam = searchParams.get("post");
  const [search, setSearch] = useState("");

  const accountsQuery = trpc.comment.accounts.useQuery(undefined, { staleTime: 60_000 });
  const accounts = accountsQuery.data ?? [];

  // Selecting an account is a DB-only lookup, so defaulting to the most recent
  // one is free. A POST is never auto-selected: opening a thread is a live
  // Graph call, and it should happen because the user asked for it.
  const selectedChannelId =
    (channelParam && accounts.some((a) => a.id === channelParam) ? channelParam : null) ??
    accounts.find((a) => a.publishedPosts > 0)?.id ??
    accounts[0]?.id ??
    null;
  const selectedAccount = accounts.find((a) => a.id === selectedChannelId) ?? null;

  const postsQuery = trpc.comment.posts.useInfiniteQuery(
    { channelId: selectedChannelId ?? "", limit: 20 },
    { enabled: !!selectedChannelId, getNextPageParam: (last) => last.nextCursor ?? undefined, staleTime: 60_000 }
  );
  const posts = useMemo(() => postsQuery.data?.pages.flatMap((p) => p.items) ?? [], [postsQuery.data]);
  const selectedPost = postParam ? posts.find((p) => p.targetId === postParam) ?? null : null;

  const filteredAccounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter(
      (a) => a.name.toLowerCase().includes(q) || (a.username ?? "").toLowerCase().includes(q)
    );
  }, [accounts, search]);

  const navigate = (channelId: string, postTargetId?: string) => {
    const params = new URLSearchParams();
    params.set("channel", channelId);
    if (postTargetId) params.set("post", postTargetId);
    router.replace(`/dashboard/comments?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <MessageSquare className="h-6 w-6" /> Comments
        </h1>
        <p className="text-sm text-muted-foreground">
          Read and reply to comments on the posts you published to your Facebook Pages and Instagram accounts.
          Comments load live from Facebook and Instagram; replies are posted publicly as the selected Page or account.
        </p>
      </div>

      {accountsQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : accountsQuery.isError ? (
        <Card>
          <CardContent className="p-6 text-sm text-destructive">{humanizeError(accountsQuery.error)}</CardContent>
        </Card>
      ) : accounts.length === 0 ? (
        <Card>
          <CardContent className="space-y-3 p-6">
            <p className="text-sm">
              Connect a Facebook Page or an Instagram professional account to read and reply to its comments here.
            </p>
            <Button asChild size="sm">
              <Link href="/dashboard/channels">Go to Channels</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,17rem)_minmax(0,21rem)_minmax(0,1fr)]">
          {/* 1 — Page / account */}
          <Card className="min-w-0">
            <CardHeader className="space-y-2 p-4 pb-2">
              <CardTitle className="text-sm">1. Page or account</CardTitle>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search accounts"
                  className="h-8 pl-7 text-xs"
                />
              </div>
            </CardHeader>
            <CardContent className="max-h-72 space-y-1 overflow-y-auto p-2 lg:max-h-[calc(100vh-15rem)]">
              {filteredAccounts.map((a) => {
                const platform = a.platform as CommentPlatform;
                const active = a.id === selectedChannelId;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => navigate(a.id)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md p-2 text-left transition-colors",
                      active ? "bg-primary/10 ring-1 ring-primary/40" : "hover:bg-muted"
                    )}
                    title={`${a.name} — ${ACCOUNT_KIND[platform]}`}
                  >
                    <ChannelAvatar avatar={a.avatar} name={a.name} className="h-8 w-8 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1 truncate text-sm font-medium">
                        <PlatformGlyph platform={platform} className="shrink-0" />
                        <span className="truncate">{a.name}</span>
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {ACCOUNT_KIND[platform]}
                        {a.username ? ` · @${a.username}` : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-0.5">
                      <span className="text-[11px] text-muted-foreground">{a.publishedPosts}</span>
                      {!a.isActive && (
                        <Badge variant="outline" className="h-4 px-1 text-[9px]">
                          Paused
                        </Badge>
                      )}
                    </span>
                  </button>
                );
              })}
              {filteredAccounts.length === 0 && (
                <p className="p-2 text-xs text-muted-foreground">No accounts match “{search}”.</p>
              )}
            </CardContent>
          </Card>

          {/* 2 — Post */}
          <Card className="min-w-0">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">2. Post</CardTitle>
              {selectedAccount && (
                <CardDescription className="flex items-center gap-1.5 text-xs">
                  <PlatformGlyph platform={selectedAccount.platform as CommentPlatform} />
                  <span className="truncate">Published to {selectedAccount.name}</span>
                </CardDescription>
              )}
            </CardHeader>
            <CardContent className="max-h-96 space-y-1 overflow-y-auto p-2 lg:max-h-[calc(100vh-15rem)]">
              {postsQuery.isLoading ? (
                <div className="space-y-2 p-2">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-14 w-full" />
                  ))}
                </div>
              ) : postsQuery.isError ? (
                <p className="p-2 text-xs text-destructive">{humanizeError(postsQuery.error)}</p>
              ) : posts.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">
                  Nothing published to this account through PostAutomation yet. Posts you publish from Content Studio
                  will appear here with their comments.
                </p>
              ) : (
                <>
                  {posts.map((p) => {
                    const active = p.targetId === selectedPost?.targetId;
                    return (
                      <button
                        key={p.targetId}
                        type="button"
                        onClick={() => selectedChannelId && navigate(selectedChannelId, p.targetId)}
                        className={cn(
                          "flex w-full gap-2.5 rounded-md p-2 text-left transition-colors",
                          active ? "bg-primary/10 ring-1 ring-primary/40" : "hover:bg-muted"
                        )}
                        title="Load this post's comments"
                      >
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                          {/* Only an IMAGE url ever reaches <img> — the server
                              never returns a video file as thumbnailUrl. */}
                          {p.thumbnailUrl ? (
                            <img
                              src={p.thumbnailUrl}
                              alt=""
                              loading="lazy"
                              referrerPolicy="no-referrer"
                              className="h-full w-full object-cover"
                            />
                          ) : p.mediaKind === "video" ? (
                            <Video className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ImageIcon className="h-4 w-4 text-muted-foreground" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 text-xs">{p.caption || <em className="text-muted-foreground">No caption</em>}</span>
                          <span className="mt-0.5 block text-[10px] text-muted-foreground">
                            {p.publishedAt ? format(new Date(p.publishedAt), "d MMM yyyy, HH:mm") : "Published"}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                  {postsQuery.hasNextPage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-full text-xs"
                      disabled={postsQuery.isFetchingNextPage}
                      onClick={() => void postsQuery.fetchNextPage()}
                    >
                      {postsQuery.isFetchingNextPage && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                      Load more posts
                    </Button>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* 3 — Comments */}
          <Card className="min-w-0">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">3. Comments</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-2 lg:max-h-[calc(100vh-13rem)] lg:overflow-y-auto">
              {postParam ? (
                // Rendered from the URL even when the post isn't in the loaded
                // page of the list (a deep link to an older post). The server
                // re-checks org ownership and returns the thread's real Page
                // identity, which the header prefers over these hints.
                <CommentThread
                  key={postParam}
                  targetId={postParam}
                  platform={selectedPost ? (selectedAccount?.platform as CommentPlatform | undefined) : undefined}
                  accountName={selectedPost ? selectedAccount?.name : undefined}
                  accountAvatar={selectedPost ? selectedAccount?.avatar : undefined}
                  publishedUrl={selectedPost?.publishedUrl ?? null}
                />
              ) : (
                <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  Select a post to load its comments from{" "}
                  {selectedAccount ? ACCOUNT_KIND[selectedAccount.platform as CommentPlatform] : "the platform"}.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
