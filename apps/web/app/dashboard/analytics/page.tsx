"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ReportsTab } from "~/components/analytics/ReportsTab";
import { ChannelAvatar } from "~/components/channel-avatar";
import { trpc } from "~/lib/trpc/client";
import { useToast } from "~/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { Badge } from "~/components/ui/badge";
import {
  BarChart3, TrendingUp, CheckCircle, XCircle, Eye, Heart, MessageCircle,
  Share, MousePointerClick, Users, Percent, Calendar, RefreshCw,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell,
} from "recharts";
import { format, subDays } from "date-fns";
import { metricCellValue, likeColumnLabel, type MetricKey, type MetricRowMeta } from "~/lib/metric-cell";

function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
}

/** Formats a metric cell honestly: "—" when the metric isn't real, else the number. */
function metricCell(key: MetricKey, value: number, meta: MetricRowMeta): string {
  const v = metricCellValue(key, value, meta);
  return v === null ? "—" : formatNumber(v);
}

const PLATFORM_COLORS: Record<string, string> = {
  TWITTER: "#1DA1F2",
  INSTAGRAM: "#E1306C",
  FACEBOOK: "#1877F2",
  LINKEDIN: "#0A66C2",
  YOUTUBE: "#FF0000",
  TIKTOK: "#010101",
  THREADS: "#000000",
  REDDIT: "#FF4500",
  PINTEREST: "#E60023",
  TELEGRAM: "#2CA5E0",
  DISCORD: "#5865F2",
  BLUESKY: "#0085FF",
  DEFAULT: "#8B5CF6",
};

function getPlatformColor(platform: string) {
  return PLATFORM_COLORS[platform] ?? PLATFORM_COLORS.DEFAULT;
}

// Recharts tooltips default to WHITE bg + series-colored text — unreadable in
// dark mode and against the dataviz rule that text wears text tokens. These
// styles pin tooltip chrome + text to theme tokens (identity comes from the
// swatch recharts already renders beside each item).
const TOOLTIP_CONTENT_STYLE = {
  fontSize: 12,
  borderRadius: 8,
  backgroundColor: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  color: "hsl(var(--card-foreground))",
} as const;
const TOOLTIP_ITEM_STYLE = { color: "hsl(var(--card-foreground))" } as const;
const TOOLTIP_LABEL_STYLE = { color: "hsl(var(--muted-foreground))" } as const;

function DateRangePicker({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  const presets = [
    { label: "7 days", days: 7 },
    { label: "30 days", days: 30 },
    { label: "90 days", days: 90 },
  ];

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {presets.map((p) => {
        const pFrom = subDays(new Date(), p.days).toISOString();
        const pTo = new Date().toISOString();
        const active = from.startsWith(pFrom.slice(0, 10));
        return (
          <button
            key={p.label}
            onClick={() => onChange(pFrom, pTo)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium border transition-colors ${
              active
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:border-primary/50"
            }`}
          >
            {p.label}
          </button>
        );
      })}
      <div className="flex items-center gap-1.5 ml-1">
        <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
        <input
          type="date"
          value={from.slice(0, 10)}
          // Parse the date input as UTC midnight, not local — otherwise a UTC+5:30
          // user's "today" shifts a day and posts drop out (audit fix 2026-06-06).
          onChange={(e) => onChange(e.target.value ? new Date(`${e.target.value}T00:00:00.000Z`).toISOString() : from, to)}
          className="text-xs border rounded-md px-2 py-1 bg-background"
        />
        <span className="text-xs text-muted-foreground">–</span>
        <input
          type="date"
          value={to.slice(0, 10)}
          onChange={(e) => onChange(from, e.target.value ? new Date(`${e.target.value}T23:59:59.999Z`).toISOString() : to)}
          className="text-xs border rounded-md px-2 py-1 bg-background"
        />
      </div>
    </div>
  );
}

function InsightsAnalyticsView() {
  const [from, setFrom] = useState(() => subDays(new Date(), 30).toISOString());
  const [to, setTo] = useState(() => new Date().toISOString());
  const [syncing, setSyncing] = useState(false);
  const { toast } = useToast();

  const dateInput = { from, to };
  const utils = trpc.useUtils();
  const triggerSync = trpc.analytics.triggerSync.useMutation({
    onSuccess: (data) => {
      if (data.queued === 0) {
        toast({ title: "Nothing to sync", description: "No published posts in the last 30 days to refresh yet." });
        setSyncing(false);
        return;
      }
      toast({ title: "Analytics sync started", description: `Refreshing ${data.queued} post${data.queued === 1 ? "" : "s"}. Numbers update as each one completes.` });
      // Worker jobs finish at different times; refetch a few times instead of a single
      // fixed cliff so slow syncs still surface without leaving stale data (audit #13).
      [4000, 9000, 15000].forEach((ms) => setTimeout(() => { void utils.analytics.invalidate(); }, ms));
      setTimeout(() => setSyncing(false), 4000);
    },
    onError: () => {
      toast({ title: "Sync failed", description: "Could not queue analytics sync.", variant: "destructive" });
      setSyncing(false);
    },
  });

  const { data: overview, isLoading: overviewLoading } = trpc.analytics.overview.useQuery(dateInput);
  const { data: engagement, isLoading: engagementLoading } = trpc.analytics.engagement.useQuery(dateInput);
  const { data: platformBreakdown, isLoading: breakdownLoading } = trpc.analytics.platformBreakdown.useQuery(dateInput);
  const { data: postsOverTime, isLoading: chartLoading } = trpc.analytics.postsOverTime.useQuery(dateInput);
  const { data: channelStats, isLoading: channelLoading } = trpc.analytics.perChannelStats.useQuery(dateInput);
  // keepPreviousData so a date-range change doesn't unmount the Group
  // Performance card mid-refetch (which would cause layout shift on every
  // range change for group-having orgs).
  const { data: groupStats, isLoading: groupLoading } = trpc.analytics.groupStats.useQuery(
    dateInput,
    { placeholderData: (prev) => prev }
  );

  const stats: Array<{ name: string; value: number; icon: any; color: string; format?: boolean; sub?: string }> = [
    { name: "Total Posts", value: overview?.totalPosts ?? 0, icon: BarChart3, color: "text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-950" },
    {
      name: "Published Targets",
      value: overview?.published ?? 0,
      icon: CheckCircle,
      color: "text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-950",
      sub: overview ? `across ${overview.totalTargets} target${overview.totalTargets === 1 ? "" : "s"}` : undefined,
    },
    { name: "Failed", value: overview?.failed ?? 0, icon: XCircle, color: "text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-950" },
    { name: "Total Reach", value: engagement?.reach ?? 0, icon: TrendingUp, color: "text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-950", format: true },
  ];

  const engagementMetrics = [
    { label: "Impressions", value: engagement?.impressions ?? 0, icon: Eye, color: "text-blue-500" },
    { label: "Likes", value: engagement?.likes ?? 0, icon: Heart, color: "text-red-500" },
    { label: "Comments", value: engagement?.comments ?? 0, icon: MessageCircle, color: "text-green-500" },
    { label: "Shares", value: engagement?.shares ?? 0, icon: Share, color: "text-purple-500" },
    { label: "Clicks", value: engagement?.clicks ?? 0, icon: MousePointerClick, color: "text-orange-500" },
    { label: "Reach", value: engagement?.reach ?? 0, icon: Users, color: "text-cyan-500" },
  ];

  // Compress chart data if more than 30 points
  const chartData = (postsOverTime ?? []).map((d) => ({
    ...d,
    label: format(new Date(d.date), "MMM d"),
  }));

  // Channels are connected but no engagement has synced yet — distinct from
  // "no channels connected" so we don't imply zero performance (audit fix 2026-06-06).
  const hasChannels = !!channelStats && channelStats.length > 0;
  const noEngagementYet =
    hasChannels &&
    channelStats!.every(
      (ch) => (ch.impressions + ch.reach + ch.likes + ch.comments + ch.shares) === 0
    );

  // Engagement Breakdown all-zeros hint (mirrors the Channel Performance
  // empty-state convention) — display-only, tile data logic untouched.
  const engagementAllZero =
    !!engagement && engagementMetrics.every((m) => m.value === 0);

  // Donut legend/center-stat inputs. The legend is contained HTML below the
  // plot (never clipped outside labels); percent shares are derived here.
  const platformTotal = (platformBreakdown ?? []).reduce((sum, e) => sum + e.count, 0);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Insights</h1>
          <p className="text-muted-foreground">See how your posts perform — reach, likes, comments &amp; shares across your channels</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <DateRangePicker
            from={from}
            to={to}
            onChange={(f, t) => { setFrom(f); setTo(t); }}
          />
          <button
            onClick={() => { setSyncing(true); triggerSync.mutate(); }}
            disabled={syncing}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing…" : "Sync Now"}
          </button>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {overviewLoading || engagementLoading
          ? [1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)
          : stats.map((stat) => (
              <Card key={stat.name}>
                <CardContent className="p-6">
                  <div className="flex items-center gap-4">
                    <div className={`rounded-lg p-2.5 ${stat.color}`}>
                      <stat.icon className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">{stat.name}</p>
                      <p className="text-2xl font-bold">
                        {stat.format ? formatNumber(stat.value) : stat.value}
                      </p>
                      {stat.sub && (
                        <p className="text-xs text-muted-foreground">{stat.sub}</p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
      </div>

      {/* Posts Over Time Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Posts Over Time</CardTitle>
          <CardDescription>Number of posts published per day</CardDescription>
        </CardHeader>
        <CardContent>
          {chartLoading ? (
            <Skeleton className="h-56 w-full rounded-lg" />
          ) : chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              {/* Fix #36: changed left margin from -20 to 8 to prevent tooltip clipping */}
              <BarChart data={chartData} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  interval="preserveStartEnd"
                  minTickGap={24}
                  tickMargin={8}
                  className="text-muted-foreground"
                />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} className="text-muted-foreground" />
                {/* Fix #36: allowEscapeViewBox + wrapperStyle prevent clipping at narrow widths */}
                <Tooltip
                  contentStyle={TOOLTIP_CONTENT_STYLE}
                  itemStyle={TOOLTIP_ITEM_STYLE}
                  labelStyle={TOOLTIP_LABEL_STYLE}
                  wrapperStyle={{ zIndex: 50 }}
                  allowEscapeViewBox={{ x: true, y: true }}
                  formatter={(v: number) => [v, "Posts"]}
                  labelFormatter={(l) => `Date: ${l}`}
                />
                <Bar dataKey="posts" fill="#6366F1" radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-56 items-center justify-center rounded-lg border border-dashed">
              <div className="text-center">
                <BarChart3 className="mx-auto h-8 w-8 text-muted-foreground/30" />
                <p className="mt-2 text-sm text-muted-foreground">No posts published in this period</p>
                {/* Fix #34: guide users to create posts */}
                <Link
                  href="/dashboard/content-agent"
                  className="mt-3 inline-block rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Create a post
                </Link>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Engagement Metrics */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Engagement Breakdown</CardTitle>
            <CardDescription>Interactions across published content</CardDescription>
          </CardHeader>
          <CardContent>
            {engagementLoading ? (
              <div className="grid grid-cols-2 gap-4">
                {[1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  {engagementMetrics.map((metric) => (
                    <div key={metric.label} className="flex items-center gap-3 rounded-lg border p-3">
                      <metric.icon className={`h-5 w-5 shrink-0 ${metric.color}`} />
                      <div>
                        <p className="text-xs text-muted-foreground">{metric.label}</p>
                        <p className="text-lg font-semibold">{formatNumber(metric.value)}</p>
                      </div>
                    </div>
                  ))}
                </div>
                {engagementAllZero && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    No engagement synced for this window yet — Twitter needs a paid API tier;
                    Instagram/Facebook sync at publish + checkpoints.
                  </p>
                )}
                <div className="mt-3 flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
                  <Percent className="h-5 w-5 text-primary" />
                  <div>
                    <p className="text-xs text-muted-foreground">Engagement Rate</p>
                    <p className="text-lg font-semibold text-primary">
                      {(engagement?.engagementRate ?? 0).toFixed(2)}%
                    </p>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Platform Breakdown Pie */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Platform Breakdown</CardTitle>
            <CardDescription>Published targets per platform</CardDescription>
          </CardHeader>
          <CardContent>
            {breakdownLoading ? (
              <Skeleton className="h-56 w-full rounded-lg" />
            ) : platformBreakdown && platformBreakdown.length > 0 ? (
              <div>
                {/* Plot area is legend-free (the legend lives below as HTML), so
                    the 220px container is all donut — nothing overlaps or clips. */}
                <div className="relative">
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie
                        data={platformBreakdown}
                        cx="50%"
                        cy="50%"
                        innerRadius={55}
                        outerRadius={85}
                        paddingAngle={3}
                        dataKey="count"
                        nameKey="platform"
                      >
                        {platformBreakdown.map((entry) => (
                          <Cell
                            key={entry.platform}
                            fill={getPlatformColor(entry.platform)}
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(v: number, name) => [
                          `${v} target${v === 1 ? "" : "s"}`,
                          name,
                        ]}
                        contentStyle={TOOLTIP_CONTENT_STYLE}
                        itemStyle={TOOLTIP_ITEM_STYLE}
                        labelStyle={TOOLTIP_LABEL_STYLE}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  {/* Total published targets centered in the donut hole */}
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <p className="text-2xl font-bold leading-none">{formatNumber(platformTotal)}</p>
                    <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                      Published
                    </p>
                  </div>
                </div>
                {/* Contained legend: identity dot carries the platform color;
                    the text itself wears foreground/muted tokens (readable in
                    both themes), never the series color. */}
                <ul className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1.5">
                  {platformBreakdown.map((entry) => (
                    <li key={entry.platform} className="flex items-center gap-1.5 text-xs">
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: getPlatformColor(entry.platform) }}
                      />
                      <span className="font-medium text-foreground">{entry.platform}</span>
                      <span className="text-muted-foreground">
                        {platformTotal > 0 ? `${Math.round((entry.count / platformTotal) * 100)}%` : "0%"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="flex h-56 items-center justify-center rounded-lg border border-dashed">
                <div className="text-center">
                  <BarChart3 className="mx-auto h-8 w-8 text-muted-foreground/30" />
                  <p className="mt-2 text-sm text-muted-foreground">Publish posts to see breakdown</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Per-Channel Stats Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Channel Performance</CardTitle>
          <CardDescription>Metrics per connected channel</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {noEngagementYet && (
            <div className="m-4 mb-0 rounded-md bg-blue-500/10 px-3 py-2 text-xs text-blue-700 dark:text-blue-400">
              Your channels are connected, but no engagement data has synced yet. Some platforms
              (e.g. Facebook/Instagram) only report metrics after a sync cycle and once permissions
              are approved. Try “Sync Now” above, or check back later.
            </div>
          )}
          {channelLoading ? (
            <div className="space-y-2 p-6">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
            </div>
          ) : channelStats && channelStats.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">Channel</th>
                    <th className="px-4 py-3 text-right font-medium text-muted-foreground">Posts</th>
                    <th className="px-4 py-3 text-right font-medium text-muted-foreground">Impressions</th>
                    <th className="px-4 py-3 text-right font-medium text-muted-foreground">Reach</th>
                    <th className="px-4 py-3 text-right font-medium text-muted-foreground">Likes</th>
                    <th className="px-4 py-3 text-right font-medium text-muted-foreground">Comments</th>
                    <th className="px-4 py-3 text-right font-medium text-muted-foreground">Shares</th>
                    <th className="px-4 py-3 text-right font-medium text-muted-foreground">Clicks</th>
                    <th className="px-4 py-3 text-right font-medium text-muted-foreground">Eng. Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {channelStats.map((ch, idx) => (
                    <tr
                      key={ch.id}
                      className={`border-b last:border-0 hover:bg-muted/20 transition-colors ${
                        idx % 2 === 0 ? "" : "bg-muted/10"
                      }`}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          <ChannelAvatar avatar={ch.avatar} name={ch.name} className="h-7 w-7 shrink-0" />
                          <div>
                            <p className="font-medium leading-none">{ch.name}</p>
                            {ch.username && (
                              <p className="text-xs text-muted-foreground mt-0.5">@{ch.username}</p>
                            )}
                          </div>
                          <Badge
                            variant="outline"
                            className="ml-1 text-[10px] px-1.5 py-0"
                            style={{ borderColor: getPlatformColor(ch.platform), color: getPlatformColor(ch.platform) }}
                          >
                            {ch.platform}
                          </Badge>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-medium">{ch.postCount}</td>
                      <td className="px-4 py-3 text-right">{metricCell("impressions", ch.impressions, ch)}</td>
                      <td className="px-4 py-3 text-right">{metricCell("reach", ch.reach, ch)}</td>
                      <td className="px-4 py-3 text-right">{metricCell("likes", ch.likes, ch)}</td>
                      <td className="px-4 py-3 text-right">{metricCell("comments", ch.comments, ch)}</td>
                      <td className="px-4 py-3 text-right">{metricCell("shares", ch.shares, ch)}</td>
                      <td className="px-4 py-3 text-right">{metricCell("clicks", ch.clicks, ch)}</td>
                      <td className="px-4 py-3 text-right">
                        {ch.hasSnapshot === false ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span
                            className={`font-medium ${
                              ch.engagementRate > 3
                                ? "text-green-600 dark:text-green-400"
                                : ch.engagementRate > 1
                                ? "text-yellow-600 dark:text-yellow-400"
                                : "text-muted-foreground"
                            }`}
                          >
                            {ch.engagementRate.toFixed(2)}%
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-4 py-3 text-xs text-muted-foreground/70 border-t">
                &ldquo;—&rdquo; means the platform doesn&rsquo;t report that metric (or it hasn&rsquo;t synced yet), not zero.
                &ldquo;Likes&rdquo; counts reactions on Facebook, saves on Pinterest, and upvotes on Reddit. Reach is shown only
                where the platform reports it separately from impressions.
              </p>
            </div>
          ) : (
            // Fix #34: empty state includes a CTA to connect channels
            <div className="flex h-48 items-center justify-center">
              <div className="text-center">
                <Users className="mx-auto h-8 w-8 text-muted-foreground/30" />
                <p className="mt-2 text-sm text-muted-foreground">No active channels found</p>
                <p className="mt-1 text-xs text-muted-foreground/70">Connect a channel to see analytics data</p>
                <Link
                  href="/dashboard/channels"
                  className="mt-3 inline-block rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Connect a channel
                </Link>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Group Performance — only when the org has channel groups. A channel
          in multiple groups counts in each; the Ungrouped bucket collects
          active channels that belong to no group. */}
      {/* Mount ONLY when the org actually has groups — never show a skeleton to
          zero-group orgs (which would then unmount, shifting layout on every
          visit). placeholderData keeps groupStats defined across refetches, so a
          group-having org's card never disappears mid-range-change. */}
      {(groupStats?.groupCount ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Group Performance</CardTitle>
            <CardDescription>Metrics summed per channel group</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {groupLoading ? (
              <div className="space-y-2 p-6">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="px-4 py-3 text-left font-medium text-muted-foreground">Group</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">Channels</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">Publishes</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">Impressions</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">Reach</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">Likes</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">Comments</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">Shares</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">Clicks</th>
                      <th className="px-4 py-3 text-right font-medium text-muted-foreground">Eng. %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(groupStats?.rows ?? []).map((g, idx) => (
                      <tr
                        key={g.id}
                        className={`border-b last:border-0 hover:bg-muted/20 transition-colors ${
                          idx % 2 === 0 ? "" : "bg-muted/10"
                        }`}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: g.color }}
                            />
                            <span className="font-medium">{g.name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">{g.channelCount}</td>
                        <td className="px-4 py-3 text-right font-medium">{g.posts}</td>
                        <td className="px-4 py-3 text-right">{formatNumber(g.impressions)}</td>
                        <td className="px-4 py-3 text-right">{formatNumber(g.reach)}</td>
                        <td className="px-4 py-3 text-right">{formatNumber(g.likes)}</td>
                        <td className="px-4 py-3 text-right">{formatNumber(g.comments)}</td>
                        <td className="px-4 py-3 text-right">{formatNumber(g.shares)}</td>
                        <td className="px-4 py-3 text-right">{formatNumber(g.clicks)}</td>
                        <td className="px-4 py-3 text-right">
                          <span
                            className={`font-medium ${
                              g.engagementRate > 3
                                ? "text-green-600 dark:text-green-400"
                                : g.engagementRate > 1
                                ? "text-yellow-600 dark:text-yellow-400"
                                : "text-muted-foreground"
                            }`}
                          >
                            {g.engagementRate.toFixed(2)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="px-4 py-3 text-xs text-muted-foreground">
                  Channels in multiple groups are counted in each group.
                  &ldquo;Publishes&rdquo; counts each post once per channel it
                  was published to, so a single post to several channels in a
                  group adds more than one.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * ?tab= deep-link reader (routing contract: emit ?tab=insights|reports).
 * Lives in its own Suspense-wrapped child so useSearchParams() doesn't opt the
 * whole page out of static generation (same pattern as OAuthCallbackToaster).
 */
function InsightsTabDeepLink({ onTab }: { onTab: (t: "insights" | "reports") => void }) {
  const searchParams = useSearchParams();
  useEffect(() => {
    const t = searchParams.get("tab");
    if (t === "reports" || t === "insights") onTab(t);
  }, [searchParams, onTab]);
  return null;
}

/**
 * Insights page (2026-07-17): two tabs —
 *  1. Insights (analytical): the existing analytics view, unchanged.
 *  2. Reports: structured, extractable per-post table over 24h/7d/15d/30d
 *     windows with CSV export (see components/analytics/ReportsTab).
 */
export default function InsightsPage() {
  const [tab, setTab] = useState<"insights" | "reports">("insights");

  return (
    <div className="space-y-6">
      <Suspense fallback={null}>
        <InsightsTabDeepLink onTab={setTab} />
      </Suspense>

      <div className="flex w-fit rounded-lg border p-0.5">
        <button
          onClick={() => setTab("insights")}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
            tab === "insights" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Insights
        </button>
        <button
          onClick={() => setTab("reports")}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
            tab === "reports" ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Reports
        </button>
      </div>

      {tab === "insights" ? <InsightsAnalyticsView /> : <ReportsTab />}
    </div>
  );
}
