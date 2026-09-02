"use client";
import { RequireAppAdmin } from "~/components/auth/require-app-admin";

import { humanizeError } from "~/lib/errors";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";
import { Switch } from "~/components/ui/switch";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { useToast } from "~/hooks/use-toast";
import {
  Rss,
  Plus,
  RefreshCw,
  Trash2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  Clock,
  Zap,
  Link2,
  FileText,
  AlertTriangle,
} from "lucide-react";

/**
 * Design: each feed card's glyph tile takes the next colour from the shared
 * accent palette (the same one the channel groups use), so a list of feeds is
 * scannable by colour instead of a column of identical orange squares.
 */
const FEED_ACCENTS = [
  "#C9A356", "#8a9a7e", "#a17a5c", "#6b7d9e",
  "#b85c5c", "#7e8a9a", "#9a8a5c", "#5c8a7e",
] as const;

// Fix #44: removed getOrgId() localStorage helper — backend scopes by session

function RssPageInner() {
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedFeed, setExpandedFeed] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [checkInterval, setCheckInterval] = useState(60);
  const [autoPost, setAutoPost] = useState(false);
  const [promptTemplate, setPromptTemplate] = useState("");

  // Fix #44: removed localStorage orgId gate — backend scopes by session
  const { data: feeds, isLoading, refetch } = trpc.rss.list.useQuery();
  const { data: channels } = trpc.channel.list.useQuery();
  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>([]);

  const createFeed = trpc.rss.create.useMutation({
    onSuccess: () => {
      refetch();
      setDialogOpen(false);
      resetForm();
      toast({ title: "RSS feed added", description: "Your feed has been created successfully." });
    },
    onError: (err) => {
      toast({ title: "Failed to add feed", description: humanizeError(err), variant: "destructive" });
    },
  });

  const deleteFeed = trpc.rss.delete.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Feed deleted" });
    },
  });

  const checkNow = trpc.rss.checkNow.useMutation({
    onSuccess: () => {
      refetch();
      // The check is async (worker pulls entries after the mutation returns),
      // so refetch again shortly to surface the new entry count / "Checked" time.
      setTimeout(() => {
        refetch();
      }, 3000);
      toast({ title: "Sync started", description: "RSS feed check has been queued." });
    },
    onError: () => {
      toast({ title: "Failed to start sync", variant: "destructive" });
    },
  });

  const resetForm = () => {
    setName("");
    setUrl("");
    setCheckInterval(60);
    setAutoPost(false);
    setPromptTemplate("");
    setSelectedChannelIds([]);
  };

  const handleCreate = () => {
    if (!name || !url) return;
    if (autoPost && selectedChannelIds.length === 0) {
      toast({ title: "Select at least one target channel for auto-post.", variant: "destructive" });
      return;
    }
    createFeed.mutate({
      name,
      url,
      checkInterval,
      autoPost,
      targetChannels: selectedChannelIds,
      promptTemplate: promptTemplate || undefined,
    });
  };

  return (
    <div className="space-y-8">
      {/* Page header — design pattern: eyebrow, display headline, sub, then a
          stat cluster and ONE gold primary CTA. */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <span className="eyebrow">RSS Feeds</span>
          <h1 className="display mt-2.5 text-[30px] leading-[1.1]">
            Turn feeds into posts.
          </h1>
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            Automate content from RSS feeds into social media posts
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <div className="flex h-9 items-center gap-3.5 rounded-[9px] border border-border bg-card px-4">
            <div>
              <div className="text-[17px] font-semibold leading-none">{feeds?.length ?? 0}</div>
              <div className="mt-0.5 whitespace-nowrap text-[9px] leading-none text-faint">feeds</div>
            </div>
            <span className="h-5 w-px bg-border2" />
            <div>
              <div className="text-[17px] font-semibold leading-none text-gold">
                {feeds?.filter((f) => f.isActive).length ?? 0}
              </div>
              <div className="mt-0.5 whitespace-nowrap text-[9px] leading-none text-faint">active</div>
            </div>
            <span className="h-5 w-px bg-border2" />
            <div>
              <div className="text-[17px] font-semibold leading-none">
                {feeds?.reduce((n, f) => n + (f._count?.entries ?? 0), 0) ?? 0}
              </div>
              <div className="mt-0.5 whitespace-nowrap text-[9px] leading-none text-faint">entries</div>
            </div>
          </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="pa-cta-gold h-9 shrink-0 gap-[7px] rounded-[9px] px-3.5 text-[12.5px] font-semibold">
              <Plus className="h-3.5 w-3.5" />
              Add Feed
            </Button>
          </DialogTrigger>
          <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>Add RSS Feed</DialogTitle>
              <DialogDescription>
                Add a new RSS feed to monitor and automatically generate posts from.
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-4">
              <div className="space-y-1.5">
                <Label htmlFor="feed-name">Feed Name</Label>
                <Input
                  id="feed-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., TechCrunch"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="feed-url">Feed URL</Label>
                <Input
                  id="feed-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/feed.xml"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="check-interval">Check Interval (minutes)</Label>
                <Input
                  id="check-interval"
                  type="number"
                  min={5}
                  max={1440}
                  value={checkInterval}
                  onChange={(e) => setCheckInterval(Number(e.target.value))}
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label htmlFor="auto-post">Auto-Post</Label>
                  <p className="text-xs text-muted-foreground">
                    Automatically generate and create draft posts from new entries
                  </p>
                </div>
                <Switch
                  id="auto-post"
                  checked={autoPost}
                  onCheckedChange={setAutoPost}
                />
              </div>
              {autoPost && (
                <>
                  <div className="space-y-1.5">
                    {/* Fix #41: clearer usage guidance */}
                    <Label htmlFor="prompt-template">AI Prompt Template (optional)</Label>
                    <Textarea
                      id="prompt-template"
                      value={promptTemplate}
                      onChange={(e) => setPromptTemplate(e.target.value)}
                      // Fix #40: use {title} syntax (not {{title}}) as shown in help text
                      placeholder="e.g. New on our blog: {title} — {summary}"
                      className="min-h-[80px] resize-none"
                    />
                    {/* Fix #40/#41: document the template syntax clearly */}
                    <p className="text-xs text-muted-foreground">
                      Available variables: <code className="font-mono">{"{title}"}</code>,{" "}
                      <code className="font-mono">{"{summary}"}</code>,{" "}
                      <code className="font-mono">{"{link}"}</code>. They are replaced when each feed item is converted into a post.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Target channels (required for auto-post)</Label>
                    {!channels || channels.length === 0 ? (
                      <p className="text-xs text-muted-foreground rounded border p-2">
                        No channels connected. Connect a channel first.
                      </p>
                    ) : (
                      <div className="max-h-40 overflow-y-auto rounded border p-2 space-y-1">
                        {channels.map((ch: any) => (
                          <label key={ch.id} className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedChannelIds.includes(ch.id)}
                              onChange={(e) =>
                                setSelectedChannelIds((prev) =>
                                  e.target.checked ? [...prev, ch.id] : prev.filter((id) => id !== ch.id)
                                )
                              }
                            />
                            {ch.name}{" "}
                            <span className="text-muted-foreground">@{ch.username ?? ch.platform}</span>
                          </label>
                        ))}
                      </div>
                    )}
                    {selectedChannelIds.length === 0 && (
                      <p className="text-xs text-amber-600">Select at least one channel, or auto-post will not run.</p>
                    )}
                  </div>
                </>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={!name || !url || createFeed.isPending}
              >
                {createFeed.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add Feed
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {/* Feed List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : !feeds || feeds.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12">
            <Rss className="h-12 w-12 text-muted-foreground/30" />
            <p className="mt-4 text-sm font-medium">No RSS feeds configured</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Add your first RSS feed to start automating content
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2.5">
          {feeds.map((feed: any, i: number) => (
            <FeedCard
              key={feed.id}
              feed={feed}
              accent={FEED_ACCENTS[i % FEED_ACCENTS.length]!}
              isExpanded={expandedFeed === feed.id}
              onToggleExpand={() =>
                setExpandedFeed(expandedFeed === feed.id ? null : feed.id)
              }
              onCheckNow={() => checkNow.mutate({ feedId: feed.id })}
              onDelete={() => {
                if (confirm("Delete this RSS feed and all its entries?")) {
                  deleteFeed.mutate({ id: feed.id });
                }
              }}
              isCheckingNow={checkNow.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FeedCard({
  feed,
  accent,
  isExpanded,
  onToggleExpand,
  onCheckNow,
  onDelete,
  isCheckingNow,
}: {
  feed: any;
  accent: string;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onCheckNow: () => void;
  onDelete: () => void;
  isCheckingNow: boolean;
}) {
  /* Design: the three actions are ONE bordered surface-1 pill of 23px buttons,
     not three loose ghost buttons — that grouping is what keeps the row from
     reading as scattered icons. */
  const actionBtn =
    "flex h-[23px] w-[23px] items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground disabled:opacity-40";

  return (
    <Card className="px-4 py-3.5 shadow-[0_6px_14px_-10px_rgba(0,0,0,.5)] transition-[border-color,transform,box-shadow] hover:-translate-y-px hover:border-[hsl(var(--accent-border))] hover:shadow-[0_10px_20px_-12px_rgba(0,0,0,.6)]">
      <div>
        <div className="flex items-start gap-3">
          {/* 34px tile tinted with this feed's accent (12% fill / 33% border). */}
          <div
            className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] border"
            style={{ backgroundColor: `${accent}22`, borderColor: `${accent}55` }}
          >
            <Rss className="h-[15px] w-[15px]" style={{ color: accent }} />
          </div>
          <div className="min-w-0 flex-1">
            {/* Row 1: name + grouped action pill */}
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-[1.3] tracking-[-0.01em]">
                {feed.name}
              </p>
              <div className="flex shrink-0 items-center gap-px rounded-[8px] border border-border bg-surface1 p-0.5">
                <button type="button" className={actionBtn} onClick={onCheckNow} disabled={isCheckingNow} title="Check Now">
                  <RefreshCw className={`h-3 w-3 ${isCheckingNow ? "animate-spin" : ""}`} />
                </button>
                <button
                  type="button"
                  className={`${actionBtn} hover:text-[#c96b56]`}
                  onClick={onDelete}
                  title="Delete Feed"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
                <button type="button" className={actionBtn} onClick={onToggleExpand} title={isExpanded ? "Collapse" : "Expand"}>
                  {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </button>
              </div>
            </div>

            {/* Row 2: status, auto-post and the URL — all chips on one line. The
                URL used to be its own full-width row of plain text. */}
            <div className="mt-[5px] flex flex-wrap items-center gap-1.5">
              <span
                className={`flex shrink-0 items-center rounded-full px-[9px] py-0.5 text-[9.5px] font-semibold leading-[1.6] ${
                  feed.isActive
                    ? "border border-[hsl(var(--accent-border))] bg-gold/[0.12] text-gold"
                    : "bg-tile text-muted-foreground"
                }`}
              >
                {feed.isActive ? "Active" : "Paused"}
              </span>
              {feed.autoPost && (
                <span className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] bg-tile px-[7px] py-[1.5px] text-[9.5px] font-medium leading-[1.6] text-muted-foreground">
                  <Zap className="h-[9px] w-[9px] text-gold" />
                  Auto-Post
                </span>
              )}
              <span className="inline-flex max-w-[260px] items-center gap-[5px] overflow-hidden truncate rounded-[5px] border border-border bg-surface1 px-2 py-[1.5px] font-mono text-[10px] leading-[1.6] text-muted-foreground">
                <Link2 className="h-[9px] w-[9px] shrink-0 text-faint" />
                {feed.url}
              </span>
            </div>

            {/* Row 3: meta */}
            <div className="mt-[7px] flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] leading-[1.4] text-faint">
              <span className="flex items-center gap-[5px]">
                <FileText className="h-[11px] w-[11px] shrink-0" />
                {feed._count?.entries ?? 0} entries
              </span>
              <span className="flex items-center gap-[5px]">
                <Clock className="h-[11px] w-[11px] shrink-0" />
                {feed.lastCheckedAt
                  ? `Checked ${new Date(feed.lastCheckedAt).toLocaleDateString()}`
                  : "Never checked"}
              </span>
              {feed.lastSyncStatus === "FAILED" && (
                <span className="flex items-center gap-[5px] text-[#e0a458]" title={feed.lastSyncError ?? ""}>
                  <AlertTriangle className="h-[11px] w-[11px] shrink-0" />
                  Last sync failed{feed.lastSyncError ? `: ${feed.lastSyncError.slice(0, 80)}` : ""}
                </span>
              )}
            </div>
          </div>
        </div>

        {isExpanded && <FeedEntries feedId={feed.id} />}
      </div>
    </Card>
  );
}

function FeedEntries({ feedId }: { feedId: string }) {
  const { data, isLoading } = trpc.rss.getEntries.useQuery(
    { feedId, limit: 10 },
    { enabled: !!feedId }
  );

  if (isLoading) {
    return (
      <div className="mt-4 space-y-2 border-t pt-4">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 rounded-lg" />
        ))}
      </div>
    );
  }

  if (!data?.entries || data.entries.length === 0) {
    return (
      <div className="mt-4 border-t pt-4 text-center text-sm text-muted-foreground">
        No entries yet. Click &quot;Check Now&quot; to fetch entries.
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-2 border-t pt-4">
      <p className="text-xs font-medium text-muted-foreground">Recent Entries</p>
      {data.entries.map((entry: any) => (
        <div
          key={entry.id}
          className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{entry.title}</p>
            <p className="truncate text-xs text-muted-foreground">
              {entry.published
                ? new Date(entry.published).toLocaleDateString()
                : "No date"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {entry.processed && (
              <Badge variant="outline" className="text-[10px]">
                Posted
              </Badge>
            )}
            {entry.link && (
              <a
                href={entry.link}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// App-level RBAC (2026-07-17): this page is an admin-only area. Server-side
// enforcement lives in tRPC (adminOrgProcedure); this wrapper only provides a
// clear "Admin access required" screen for USER-role deep links.
export default function RssPage() {
  return (
    <RequireAppAdmin>
      <RssPageInner />
    </RequireAppAdmin>
  );
}
