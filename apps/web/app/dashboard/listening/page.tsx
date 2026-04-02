"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  Ear,
  Plus,
  Search,
  TrendingUp,
  TrendingDown,
  Minus,
  MessageCircle,
  Users,
  Bell,
  AlertTriangle,
  RefreshCw,
  Loader2,
  Trash2,
  Power,
  PowerOff,
  ThumbsUp,
  ThumbsDown,
  ExternalLink,
  Smile,
  Frown,
  Meh,
} from "lucide-react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";

const sentimentColors = {
  POSITIVE: "text-emerald-600 bg-emerald-100 dark:bg-emerald-900/40 dark:text-emerald-400",
  NEGATIVE: "text-red-600 bg-red-100 dark:bg-red-900/40 dark:text-red-400",
  NEUTRAL: "text-gray-600 bg-gray-100 dark:bg-gray-800 dark:text-gray-400",
  MIXED: "text-amber-600 bg-amber-100 dark:bg-amber-900/40 dark:text-amber-400",
};

const sentimentIcons = {
  POSITIVE: Smile,
  NEGATIVE: Frown,
  NEUTRAL: Meh,
  MIXED: Meh,
};

export default function ListeningPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [keywords, setKeywords] = useState("");
  const [excludeWords, setExcludeWords] = useState("");
  const [selectedQuery, setSelectedQuery] = useState<string | undefined>();

  const { data: queries, isLoading: queriesLoading } = trpc.listening.listQueries.useQuery();
  const { data: overview, isLoading: overviewLoading } = trpc.listening.sentimentOverview.useQuery({
    queryId: selectedQuery,
    days: 30,
  });
  const { data: mentions, isLoading: mentionsLoading } = trpc.listening.mentions.useQuery({
    queryId: selectedQuery,
    limit: 20,
  });
  const { data: alerts } = trpc.listening.alerts.useQuery({
    queryId: selectedQuery,
    unreadOnly: true,
  });
  const { data: sources } = trpc.listening.sourceBreakdown.useQuery({
    queryId: selectedQuery,
    days: 30,
  });

  const utils = trpc.useUtils();

  const createMutation = trpc.listening.createQuery.useMutation({
    onSuccess: () => {
      utils.listening.listQueries.invalidate();
      setDialogOpen(false);
      setName("");
      setKeywords("");
      setExcludeWords("");
    },
  });

  const updateMutation = trpc.listening.updateQuery.useMutation({
    onSuccess: () => utils.listening.listQueries.invalidate(),
  });

  const deleteMutation = trpc.listening.deleteQuery.useMutation({
    onSuccess: () => {
      utils.listening.listQueries.invalidate();
      if (selectedQuery) setSelectedQuery(undefined);
    },
  });

  const syncMutation = trpc.listening.triggerSync.useMutation({
    onSuccess: () => {
      utils.listening.mentions.invalidate();
      utils.listening.sentimentOverview.invalidate();
    },
  });

  const markAlertRead = trpc.listening.markAlertRead.useMutation({
    onSuccess: () => utils.listening.alerts.invalidate(),
  });

  const handleCreate = () => {
    createMutation.mutate({
      name,
      keywords: keywords.split(",").map((k) => k.trim()).filter(Boolean),
      excludeWords: excludeWords ? excludeWords.split(",").map((w) => w.trim()).filter(Boolean) : [],
    });
  };

  const sentimentPercent = (count: number) => {
    const total = overview?.total ?? 0;
    return total > 0 ? Math.round((count / total) * 100) : 0;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Social Listening</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Monitor brand mentions, sentiment, and competitor activity
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              New Query
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Listening Query</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Query Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Brand Mentions, Competitor Watch"
                />
              </div>
              <div>
                <Label>Keywords to Track</Label>
                <Input
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                  placeholder="brand name, product, @handle (comma separated)"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Enter brand names, product names, or handles to monitor
                </p>
              </div>
              <div>
                <Label>Exclude Words (optional)</Label>
                <Input
                  value={excludeWords}
                  onChange={(e) => setExcludeWords(e.target.value)}
                  placeholder="spam, sale (comma separated)"
                />
              </div>
              <Button
                onClick={handleCreate}
                disabled={!name || !keywords || createMutation.isPending}
                className="w-full"
              >
                {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Query
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Alerts Banner */}
      {alerts && alerts.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
          <div className="flex items-center gap-2 mb-2">
            <Bell className="h-4 w-4 text-amber-600" />
            <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              {alerts.length} Unread Alert{alerts.length > 1 ? "s" : ""}
            </span>
          </div>
          <div className="space-y-2">
            {alerts.slice(0, 3).map((alert) => (
              <div key={alert.id} className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                    {alert.title}
                  </p>
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {alert.description.slice(0, 120)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-xs"
                  onClick={() => markAlertRead.mutate({ id: alert.id })}
                >
                  Dismiss
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Query Tabs */}
      {queries && queries.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <Button
            variant={!selectedQuery ? "default" : "outline"}
            size="sm"
            className="shrink-0"
            onClick={() => setSelectedQuery(undefined)}
          >
            All Queries
          </Button>
          {queries.map((q) => (
            <Button
              key={q.id}
              variant={selectedQuery === q.id ? "default" : "outline"}
              size="sm"
              className="shrink-0"
              onClick={() => setSelectedQuery(q.id)}
            >
              {q.name}
              <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5">
                {q._count.mentions}
              </Badge>
            </Button>
          ))}
        </div>
      )}

      {/* Sentiment Overview */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { title: "Total Mentions", value: overview?.total ?? 0, icon: MessageCircle, color: "text-blue-500" },
          { title: "Total Reach", value: (overview?.totalReach ?? 0).toLocaleString(), icon: Users, color: "text-violet-500" },
          { title: "Avg Sentiment", value: (overview?.avgSentimentScore ?? 0).toFixed(2), icon: TrendingUp, color: overview?.avgSentimentScore && overview.avgSentimentScore > 0 ? "text-emerald-500" : "text-red-500" },
          { title: "Total Engagements", value: (overview?.totalEngagements ?? 0).toLocaleString(), icon: TrendingUp, color: "text-amber-500" },
        ].map((stat) => (
          <Card key={stat.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {stat.title}
              </CardTitle>
              <stat.icon className={`h-4 w-4 ${stat.color}`} />
            </CardHeader>
            <CardContent>
              {overviewLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <p className="text-2xl font-bold">{stat.value}</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Sentiment Breakdown Bar */}
      {overview && overview.total > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Sentiment Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex h-4 w-full overflow-hidden rounded-full">
              <div
                className="bg-emerald-500 transition-all"
                style={{ width: `${sentimentPercent(overview.positive)}%` }}
              />
              <div
                className="bg-gray-400 transition-all"
                style={{ width: `${sentimentPercent(overview.neutral)}%` }}
              />
              <div
                className="bg-amber-500 transition-all"
                style={{ width: `${sentimentPercent(overview.mixed)}%` }}
              />
              <div
                className="bg-red-500 transition-all"
                style={{ width: `${sentimentPercent(overview.negative)}%` }}
              />
            </div>
            <div className="mt-3 flex items-center gap-6 text-xs">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                Positive {sentimentPercent(overview.positive)}%
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-gray-400" />
                Neutral {sentimentPercent(overview.neutral)}%
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
                Mixed {sentimentPercent(overview.mixed)}%
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
                Negative {sentimentPercent(overview.negative)}%
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Recent Mentions */}
        <div className="lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-muted-foreground">Recent Mentions</h2>
            {selectedQuery && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => syncMutation.mutate({ queryId: selectedQuery })}
                disabled={syncMutation.isPending}
              >
                {syncMutation.isPending ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 h-3 w-3" />
                )}
                Sync Now
              </Button>
            )}
          </div>
          <div className="space-y-2">
            {mentionsLoading ? (
              [1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 rounded-xl" />)
            ) : mentions?.items && mentions.items.length > 0 ? (
              mentions.items.map((mention) => {
                const SentimentIcon = sentimentIcons[mention.sentiment] || Meh;
                return (
                  <div
                    key={mention.id}
                    className="flex items-start gap-3 rounded-xl border border-border/30 bg-card/50 p-3.5 transition-colors hover:bg-card/80"
                  >
                    <div className={`mt-0.5 rounded-lg p-1.5 ${sentimentColors[mention.sentiment] ?? sentimentColors.NEUTRAL}`}>
                      <SentimentIcon className="h-3.5 w-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm">{mention.content}</p>
                      <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground">
                        {mention.authorName && (
                          <span className="font-medium">{mention.authorName}</span>
                        )}
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                          {mention.source}
                        </Badge>
                        <span>
                          {formatDistanceToNow(new Date(mention.mentionedAt), { addSuffix: true })}
                        </span>
                      </div>
                    </div>
                    {mention.sourceUrl && (
                      <a href={mention.sourceUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/40 hover:text-foreground" />
                      </a>
                    )}
                  </div>
                );
              })
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center py-8 text-center">
                  <Ear className="h-10 w-10 text-muted-foreground/30 mb-3" />
                  <p className="text-sm text-muted-foreground">
                    {queries && queries.length > 0
                      ? "No mentions found yet. Try syncing or adjusting your keywords."
                      : "Create a listening query to start monitoring mentions."}
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {/* Sidebar: Sources + Queries */}
        <div className="space-y-6">
          {/* Source Breakdown */}
          {sources && sources.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">Sources</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {sources.map((s) => (
                  <div key={s.source} className="flex items-center justify-between">
                    <span className="text-sm">{s.source}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{s.count}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {s.reach.toLocaleString()} reach
                      </span>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Listening Queries */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Your Queries</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {queriesLoading ? (
                [1, 2].map((i) => <Skeleton key={i} className="h-12 rounded-xl" />)
              ) : queries && queries.length > 0 ? (
                queries.map((q) => (
                  <div
                    key={q.id}
                    className="flex items-center justify-between rounded-lg border border-border/30 p-2.5"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{q.name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {q.keywords.slice(0, 3).join(", ")}
                        {q._count.mentions > 0 && ` · ${q._count.mentions} mentions`}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() =>
                          updateMutation.mutate({ id: q.id, isActive: !q.isActive })
                        }
                      >
                        {q.isActive ? (
                          <Power className="h-3 w-3 text-emerald-500" />
                        ) : (
                          <PowerOff className="h-3 w-3 text-muted-foreground" />
                        )}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive"
                        onClick={() => {
                          if (confirm("Delete this query and all its mentions?")) {
                            deleteMutation.mutate({ id: q.id });
                          }
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No queries yet
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
