"use client";

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
} from "lucide-react";

function getOrgId(): string {
  if (typeof window !== "undefined") {
    return localStorage.getItem("currentOrgId") || "";
  }
  return "";
}

export default function RssPage() {
  const { toast } = useToast();
  const orgId = getOrgId();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedFeed, setExpandedFeed] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [checkInterval, setCheckInterval] = useState(60);
  const [autoPost, setAutoPost] = useState(false);
  const [promptTemplate, setPromptTemplate] = useState("");

  // organizationId is derived from session on the backend (security fix:
  // previously the client could pass any orgId).
  const { data: feeds, isLoading, refetch } = trpc.rss.list.useQuery(
    undefined,
    { enabled: !!orgId }
  );

  const createFeed = trpc.rss.create.useMutation({
    onSuccess: () => {
      refetch();
      setDialogOpen(false);
      resetForm();
      toast({ title: "RSS feed added", description: "Your feed has been created successfully." });
    },
    onError: (err) => {
      toast({ title: "Failed to add feed", description: err.message, variant: "destructive" });
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
  };

  const handleCreate = () => {
    if (!name || !url) return;
    createFeed.mutate({
      name,
      url,
      checkInterval,
      autoPost,
      targetChannels: [],
      promptTemplate: promptTemplate || undefined,
    });
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">RSS Feeds</h1>
          <p className="text-muted-foreground">
            Automate content from RSS feeds into social media posts
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              Add Feed
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>Add RSS Feed</DialogTitle>
              <DialogDescription>
                Add a new RSS feed to monitor and automatically generate posts from.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
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
                <div className="space-y-1.5">
                  <Label htmlFor="prompt-template">AI Prompt Template (optional)</Label>
                  <Textarea
                    id="prompt-template"
                    value={promptTemplate}
                    onChange={(e) => setPromptTemplate(e.target.value)}
                    placeholder="Create an engaging tweet about: {{title}} - {{summary}}"
                    className="min-h-[80px] resize-none"
                  />
                  <p className="text-xs text-muted-foreground">
                    Use {"{{title}}"} and {"{{summary}}"} as placeholders
                  </p>
                </div>
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
        <div className="space-y-3">
          {feeds.map((feed: any) => (
            <FeedCard
              key={feed.id}
              feed={feed}
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
  isExpanded,
  onToggleExpand,
  onCheckNow,
  onDelete,
  isCheckingNow,
}: {
  feed: any;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onCheckNow: () => void;
  onDelete: () => void;
  isCheckingNow: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-100 text-orange-600 dark:bg-orange-950 dark:text-orange-400">
            <Rss className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate font-medium">{feed.name}</p>
              <Badge variant={feed.isActive ? "default" : "secondary"} className="text-[10px]">
                {feed.isActive ? "Active" : "Paused"}
              </Badge>
              {feed.autoPost && (
                <Badge variant="outline" className="text-[10px]">
                  Auto-Post
                </Badge>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">{feed.url}</p>
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <div className="text-right">
              <p className="text-xs">
                {feed._count?.entries ?? 0} entries
              </p>
              <p className="flex items-center gap-1 text-[10px]">
                <Clock className="h-3 w-3" />
                {feed.lastCheckedAt
                  ? `Checked ${new Date(feed.lastCheckedAt).toLocaleDateString()}`
                  : "Never checked"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onCheckNow}
              disabled={isCheckingNow}
              title="Check Now"
            >
              <RefreshCw className={`h-4 w-4 ${isCheckingNow ? "animate-spin" : ""}`} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive hover:text-destructive"
              onClick={onDelete}
              title="Delete Feed"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onToggleExpand}
              title={isExpanded ? "Collapse" : "Expand"}
            >
              {isExpanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        {isExpanded && <FeedEntries feedId={feed.id} />}
      </CardContent>
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
