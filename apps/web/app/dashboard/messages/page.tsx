"use client";

import { Suspense, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Mail, RefreshCw, Search, ShieldAlert } from "lucide-react";
import type { SocialConversation } from "@postautomation/social";
import { trpc } from "~/lib/trpc/client";
import { humanizeError } from "~/lib/errors";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
import { ChannelAvatar } from "~/components/channel-avatar";
import { ACCOUNT_KIND, PlatformGlyph, RelativeTime, type CommentPlatform } from "~/components/comments/comment-thread";
import { MessageThread } from "~/components/messages/message-thread";
import { participantLabel } from "~/lib/messages";
import { cn } from "~/lib/utils";

/**
 * Messages inbox (2026-10-05) — Messenger conversations of a connected
 * Facebook Page and Instagram Direct conversations of a connected Instagram
 * account, live from Meta.
 *
 * 1. pick a Page / account   2. pick a conversation   3. read and reply
 *
 * Deep link: /dashboard/messages?channel=<channelId>&conversation=<id>
 *
 * Needs Meta's messaging permissions on the channel's token
 * (pages_messaging + pages_manage_metadata on Facebook, instagram_manage_messages
 * + pages_manage_metadata on Instagram). Until Meta approves them for everyone,
 * the account shows "Reconnect" with the missing permission named.
 */
export default function MessagesPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <MessagesInbox />
    </Suspense>
  );
}

const PERMISSION_COPY =
  "This needs Meta's messaging permission on this channel. Reconnect it on the Channels page (choose “Edit settings” and keep it ticked). If it still isn't available, Meta hasn't approved messaging for accounts outside our own team yet.";

function MessagesInbox() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const channelParam = searchParams.get("channel");
  const conversationParam = searchParams.get("conversation");
  const [search, setSearch] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);

  const accountsQuery = trpc.message.accounts.useQuery(undefined, { staleTime: 60_000 });
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  // Prefer an account whose grant already allows the inbox.
  const selectedChannelId =
    (channelParam && accounts.some((a) => a.id === channelParam) ? channelParam : null) ??
    accounts.find((a) => a.messageAccess.canUseInbox === true)?.id ??
    accounts[0]?.id ??
    null;
  const selectedAccount = accounts.find((a) => a.id === selectedChannelId) ?? null;

  const conversationsQuery = trpc.message.conversations.useInfiniteQuery(
    { channelId: selectedChannelId ?? "" },
    {
      enabled: !!selectedChannelId,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: 60_000,
      staleTime: 30_000,
    }
  );
  const firstPage = conversationsQuery.data?.pages[0];
  const conversations = useMemo(() => {
    const seen = new Set<string>();
    const out: SocialConversation[] = [];
    for (const page of conversationsQuery.data?.pages ?? []) {
      for (const c of page.conversations) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
      }
    }
    return out;
  }, [conversationsQuery.data]);

  const filteredAccounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((a) => a.name.toLowerCase().includes(q) || (a.username ?? "").toLowerCase().includes(q));
  }, [accounts, search]);

  const navigate = (channelId: string, conversationId?: string) => {
    const params = new URLSearchParams();
    params.set("channel", channelId);
    if (conversationId) params.set("conversation", conversationId);
    router.replace(`/dashboard/messages?${params.toString()}`, { scroll: false });
    if (conversationId && typeof window !== "undefined" && window.innerWidth < 1280) {
      requestAnimationFrame(() => threadRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  };

  const blocked = firstPage?.blocked === true;
  const missing = firstPage?.capabilities.missingForInbox ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Mail className="h-6 w-6" /> Messages
        </h1>
        <p className="text-sm text-muted-foreground">
          Messenger and Instagram Direct conversations of your Facebook Pages and Instagram accounts, live from Meta.
          You can reply within 24 hours of a person&apos;s last message.
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
            <p className="text-sm">Connect a Facebook Page or an Instagram professional account to see its messages here.</p>
            <Button asChild size="sm">
              <Link href="/dashboard/channels">Go to Channels</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,14rem)_minmax(0,18rem)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,17rem)_minmax(0,21rem)_minmax(0,1fr)]">
          {/* 1 — Page / account */}
          <Card className="min-w-0">
            <CardHeader className="space-y-2 p-4 pb-2">
              <CardTitle className="text-sm">1. Page or account</CardTitle>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search accounts" className="h-8 pl-7 text-xs" />
              </div>
            </CardHeader>
            <CardContent className="max-h-72 space-y-1 overflow-y-auto p-2 xl:max-h-[calc(100vh-15rem)]">
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
                    {a.messageAccess.known && a.messageAccess.canUseInbox === false && (
                      <Badge
                        variant="outline"
                        className="h-4 shrink-0 border-amber-500 px-1 text-[9px] text-amber-600 dark:text-amber-400"
                        title={`Reconnect to enable messages — missing ${a.messageAccess.missingForInbox.join(", ")}`}
                        data-testid="messages-reconnect-badge"
                      >
                        Reconnect
                      </Badge>
                    )}
                  </button>
                );
              })}
              {filteredAccounts.length === 0 && <p className="p-2 text-xs text-muted-foreground">No accounts match “{search}”.</p>}
            </CardContent>
          </Card>

          {/* 2 — Conversation */}
          <Card className="min-w-0">
            <CardHeader className="p-4 pb-2">
              <div className="flex items-center gap-2">
                <CardTitle className="flex-1 text-sm">2. Conversation</CardTitle>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5"
                  onClick={() => void conversationsQuery.refetch()}
                  disabled={!selectedChannelId || conversationsQuery.isFetching}
                  title="Refresh conversations"
                >
                  <RefreshCw className={cn("h-3 w-3", conversationsQuery.isFetching && "animate-spin")} />
                </Button>
              </div>
              {selectedAccount && (
                <CardDescription className="flex items-center gap-1.5 text-xs">
                  <PlatformGlyph platform={selectedAccount.platform as CommentPlatform} />
                  <span className="truncate">{selectedAccount.platform === "FACEBOOK" ? "Messenger" : "Instagram Direct"} · {selectedAccount.name}</span>
                </CardDescription>
              )}
            </CardHeader>
            <CardContent className="max-h-96 space-y-1 overflow-y-auto p-2 xl:max-h-[calc(100vh-15rem)]">
              {conversationsQuery.isLoading ? (
                <div className="space-y-2 p-2">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : conversationsQuery.isError ? (
                <p className="flex items-start gap-1.5 p-2 text-xs text-destructive">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {humanizeError(conversationsQuery.error)}
                </p>
              ) : blocked ? (
                <div className="space-y-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300" data-testid="messages-blocked">
                  <p>{PERMISSION_COPY}</p>
                  {missing.length > 0 && <p className="text-[11px]">Missing: {missing.join(", ")}</p>}
                  <Button asChild size="sm" variant="outline" className="h-7 text-xs">
                    <Link href="/dashboard/channels">Go to Channels</Link>
                  </Button>
                </div>
              ) : conversations.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">No conversations yet.</p>
              ) : (
                <>
                  {conversations.map((c) => {
                    const active = c.id === conversationParam;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => selectedChannelId && navigate(selectedChannelId, c.id)}
                        className={cn(
                          "flex w-full flex-col gap-0.5 rounded-md p-2 text-left transition-colors",
                          active ? "bg-primary/10 ring-1 ring-primary/40" : "hover:bg-muted"
                        )}
                        data-testid="conversation-row"
                      >
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">{participantLabel(c.participant)}</span>
                          {c.unreadCount ? (
                            <Badge className="h-4 px-1.5 text-[10px]">{c.unreadCount}</Badge>
                          ) : null}
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            <RelativeTime value={c.updatedAt} />
                          </span>
                        </span>
                        {c.snippet && (
                          <span className="truncate text-[11px] text-muted-foreground">
                            {c.lastFromAccount ? "You: " : ""}
                            {c.snippet}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {conversationsQuery.hasNextPage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-full text-xs"
                      onClick={() => void conversationsQuery.fetchNextPage()}
                      disabled={conversationsQuery.isFetchingNextPage}
                    >
                      {conversationsQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                    </Button>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* 3 — Thread */}
          <Card ref={threadRef} className="min-w-0 scroll-mt-4 lg:col-span-2 xl:col-span-1">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">3. Messages</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              {selectedAccount && conversationParam && !blocked ? (
                <MessageThread
                  key={`${selectedAccount.id}:${conversationParam}`}
                  channelId={selectedAccount.id}
                  conversationId={conversationParam}
                  platform={selectedAccount.platform as "FACEBOOK" | "INSTAGRAM"}
                  accountName={selectedAccount.name}
                />
              ) : (
                <p className="text-xs text-muted-foreground">Pick a conversation to read it and reply.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
