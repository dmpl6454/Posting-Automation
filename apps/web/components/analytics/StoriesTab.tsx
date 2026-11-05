"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { Badge } from "~/components/ui/badge";
import { ChannelAvatar } from "~/components/channel-avatar";
import { Download, ExternalLink, Film, Info, Loader2, RefreshCw } from "lucide-react";
import { toCsv, downloadCsv } from "~/lib/csv";
import { useToast } from "~/hooks/use-toast";
import { humanizeError } from "~/lib/errors";
import {
  STORY_METRIC_COLUMNS,
  metricText,
  storyCsv,
  storyLifeLabel,
  storyReadingLabel,
  storyStatusLabel,
  type StoryRowView,
} from "~/lib/story-insights-view";

const RANGES = [
  { days: 1, label: "24 hours" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

const PLATFORMS = [
  { value: undefined, label: "All" },
  { value: "INSTAGRAM", label: "Instagram" },
  { value: "FACEBOOK", label: "Facebook" },
] as const;

type PlatformFilter = (typeof PLATFORMS)[number]["value"];

/**
 * Insights → Stories (2026-11-05): every story published through PostAutomation,
 * with Instagram's story metrics. A story's insights disappear 24 hours after it
 * is posted, so the app captures them while it is live (at publish, every few
 * hours, and once more about an hour before it expires); the last reading is
 * what stays here afterwards.
 */
export function StoriesTab() {
  const [days, setDays] = useState<number>(7);
  const [platform, setPlatform] = useState<PlatformFilter>(undefined);
  const [syncing, setSyncing] = useState(false);
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const query = trpc.analytics.storyInsights.useQuery(
    { days, ...(platform ? { platform } : {}) },
    { placeholderData: (prev) => prev, refetchInterval: 5 * 60_000 }
  );

  const sync = trpc.analytics.triggerSync.useMutation({
    onSuccess: (data) => {
      toast({
        title: data.queued > 0 ? "Refreshing story insights" : "Nothing to refresh",
        description:
          data.queued > 0
            ? "Live stories are being re-measured. Numbers update in a minute or two."
            : "No live stories to measure. A story's insights are only available while it is live.",
      });
      [5000, 15000, 45000].forEach((ms) => setTimeout(() => void utils.analytics.storyInsights.invalidate(), ms));
      setTimeout(() => setSyncing(false), 5000);
    },
    onError: (err) => {
      toast({ title: "Refresh failed", description: humanizeError(err), variant: "destructive" });
      setSyncing(false);
    },
  });

  const data = query.data;
  const rows = (data?.rows ?? []) as unknown as (StoryRowView & {
    targetId: string;
    channelAvatar: string | null;
    thumbnailUrl: string | null;
    isVideo: boolean;
  })[];
  const totals = data?.totals;

  const exportCsv = () => {
    const { header, body } = storyCsv(rows);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`postautomation-story-insights-${days}d-${stamp}.csv`, toCsv(header, body));
  };

  const cards: { label: string; value: number | null | undefined; hint?: string }[] = [
    { label: "Stories", value: totals?.stories, hint: totals ? `${totals.live} live now` : undefined },
    { label: "Views", value: totals?.views },
    { label: "Reach (summed)", value: totals?.reachSummed, hint: "Added up per story, so one person can count more than once" },
    { label: "Replies", value: totals?.replies },
    { label: "Exits", value: totals?.exits },
    { label: "Profile visits", value: totals?.profileVisits },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-[10px] border border-border bg-surface1 p-1">
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              className={`rounded-[8px] px-3 py-1.5 text-[12px] leading-none transition-colors ${
                days === r.days ? "bg-tile font-semibold text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 rounded-[10px] border border-border bg-surface1 p-1">
          {PLATFORMS.map((p) => (
            <button
              key={p.label}
              onClick={() => setPlatform(p.value)}
              className={`rounded-[8px] px-3 py-1.5 text-[12px] leading-none transition-colors ${
                platform === p.value ? "bg-tile font-semibold text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={syncing}
            onClick={() => {
              setSyncing(true);
              sync.mutate({ days: 2 });
            }}
          >
            {syncing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
            Refresh live stories
          </Button>
          <Button variant="outline" size="sm" disabled={rows.length === 0} onClick={exportCsv}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardContent className="p-4">
              <div className="text-[11.5px] text-muted-foreground">{c.label}</div>
              <div className="mt-1 text-xl font-semibold">
                {query.isLoading ? <Skeleton className="h-6 w-14" /> : metricText(c.value ?? null)}
              </div>
              {c.hint && <div className="mt-1 text-[11px] text-muted-foreground">{c.hint}</div>}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Stories</CardTitle>
          <CardDescription>
            Stories published through PostAutomation. Instagram removes a story&apos;s insights 24 hours after
            posting, so we capture them while the story is live and keep the last reading. Facebook doesn&apos;t
            report story insights.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {query.isLoading ? (
            <div className="space-y-2 p-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : query.isError ? (
            <div className="p-6 text-sm text-destructive">{humanizeError(query.error)}</div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
              <Film className="h-6 w-6" />
              No stories published through PostAutomation in this period. Post one from Content Studio in Story mode.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full whitespace-nowrap text-[12.5px]">
                <thead>
                  <tr className="border-b border-border text-left text-[11.5px] text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Story</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    {STORY_METRIC_COLUMNS.map((c) => (
                      <th key={c.key} className="px-3 py-2 text-right font-medium" title={c.hint}>
                        {c.label}
                      </th>
                    ))}
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const message = storyStatusLabel(r.status);
                    const reading = storyReadingLabel(r);
                    return (
                      <tr key={r.targetId} className="border-b border-border/60 last:border-0">
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-3">
                            <div className="flex h-12 w-[27px] shrink-0 items-center justify-center overflow-hidden rounded-[4px] bg-tile">
                              {r.thumbnailUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={r.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                              ) : (
                                <Film className="h-3.5 w-3.5 text-muted-foreground" />
                              )}
                            </div>
                            <ChannelAvatar avatar={r.channelAvatar} name={r.channelName} className="h-6 w-6" />
                            <div className="min-w-0">
                              <div className="max-w-[220px] truncate font-medium">{r.channelName}</div>
                              <div className="text-[11.5px] text-muted-foreground">
                                {r.platform === "INSTAGRAM" ? "Instagram" : "Facebook"} ·{" "}
                                {new Date(r.publishedAt).toLocaleString(undefined, {
                                  day: "numeric",
                                  month: "short",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-1.5">
                              <Badge variant={r.live ? "default" : "secondary"} className="text-[10.5px]">
                                {storyLifeLabel(r)}
                              </Badge>
                              {reading && <span className="text-[11px] text-muted-foreground">{reading}</span>}
                            </div>
                            {message && (
                              <span
                                className={`flex items-center gap-1 text-[11px] ${
                                  r.status === "reconnect" ? "text-amber-500" : "text-muted-foreground"
                                }`}
                              >
                                <Info className="h-3 w-3" />
                                {message}
                              </span>
                            )}
                          </div>
                        </td>
                        {STORY_METRIC_COLUMNS.map((c) => (
                          <td key={c.key} className="px-3 py-2.5 text-right tabular-nums">
                            {metricText(r[c.key] as number | null)}
                          </td>
                        ))}
                        <td className="px-3 py-2.5">
                          {r.url && (
                            <a
                              href={r.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-muted-foreground hover:text-foreground"
                              title="Open on the platform"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {data?.truncated && (
            <div className="border-t border-border px-4 py-2 text-[11.5px] text-muted-foreground">
              Showing the newest {rows.length.toLocaleString()} of {data.total.toLocaleString()} stories. Pick a shorter
              period to see the rest.
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-[11.5px] text-muted-foreground">
        Tap and exit counts, profile visits and link clicks are captured for stories posted from 5 Nov 2026 onward.
        Stories under 5 viewers show no insights; Instagram withholds them.
      </p>
    </div>
  );
}
