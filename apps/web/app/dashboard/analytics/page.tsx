"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { toast } from "~/components/ui/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { Badge } from "~/components/ui/badge";
import {
  BarChart3, TrendingUp, CheckCircle, XCircle, Eye, Heart, MessageCircle,
  Share, MousePointerClick, Users, Percent, Calendar, RefreshCw,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from "recharts";
import { format, subDays } from "date-fns";

function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
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

const PIE_COLORS = ["#6366F1", "#EC4899", "#F59E0B", "#10B981", "#3B82F6", "#EF4444", "#8B5CF6"];

function getPlatformColor(platform: string) {
  return PLATFORM_COLORS[platform] ?? PLATFORM_COLORS.DEFAULT;
}

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
          onChange={(e) => onChange(new Date(e.target.value).toISOString(), to)}
          className="text-xs border rounded-md px-2 py-1 bg-background"
        />
        <span className="text-xs text-muted-foreground">–</span>
        <input
          type="date"
          value={to.slice(0, 10)}
          onChange={(e) => onChange(from, new Date(e.target.value).toISOString())}
          className="text-xs border rounded-md px-2 py-1 bg-background"
        />
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const [from, setFrom] = useState(() => subDays(new Date(), 30).toISOString());
  const [to, setTo] = useState(() => new Date().toISOString());
  const [syncing, setSyncing] = useState(false);

  const dateInput = { from, to };
  const utils = trpc.useUtils();
  const triggerSync = trpc.analytics.triggerSync.useMutation({
    onSuccess: (data) => {
      toast({ title: "Analytics sync started", description: `Queued ${data.queued} posts for refresh. Data will update shortly.` });
      setSyncing(false);
      setTimeout(() => { void utils.analytics.invalidate(); }, 8000);
    },
    onError: () => {
      toast({ title: "Sync failed", description: "Could not queue analytics sync.", variant: "destructive" });
      setSyncing(false);
    },
  });

  const { data: overview, isLoading: overviewLoading } = trpc.analytics.overview.useQuery(dateInput);
  const { data: engagement, isLoading: engagementLoading } = trpc.analytics.engagement.useQuery(dateInput);
  const { data: platformBreakdown, isLoading: breakdownLoading } = trpc.analytics.platformBreakdown.useQuery();
  const { data: postsOverTime, isLoading: chartLoading } = trpc.analytics.postsOverTime.useQuery(dateInput);
  const { data: channelStats, isLoading: channelLoading } = trpc.analytics.perChannelStats.useQuery(dateInput);

  const stats = [
    { name: "Total Posts", value: overview?.totalPosts ?? 0, icon: BarChart3, color: "text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-950" },
    { name: "Published Targets", value: overview?.published ?? 0, icon: CheckCircle, color: "text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-950" },
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

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
          <p className="text-muted-foreground">Track your social media performance across all platforms</p>
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
              <BarChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  interval={Math.ceil(chartData.length / 10) - 1}
                  className="text-muted-foreground"
                />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} className="text-muted-foreground" />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
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
            <CardDescription>Published posts per platform</CardDescription>
          </CardHeader>
          <CardContent>
            {breakdownLoading ? (
              <Skeleton className="h-56 w-full rounded-lg" />
            ) : platformBreakdown && platformBreakdown.length > 0 ? (
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
                    label={({ platform, percent }) =>
                      `${platform} ${(percent * 100).toFixed(0)}%`
                    }
                    labelLine={false}
                  >
                    {platformBreakdown.map((entry, index) => (
                      <Cell
                        key={entry.platform}
                        fill={getPlatformColor(entry.platform) ?? PIE_COLORS[index % PIE_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(v: number, name) => [v, name]}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
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
                          {ch.avatar ? (
                            <img src={ch.avatar} alt={ch.name} className="h-7 w-7 rounded-full object-cover" />
                          ) : (
                            <div
                              className="h-7 w-7 rounded-full flex items-center justify-center text-white text-xs font-bold"
                              style={{ backgroundColor: getPlatformColor(ch.platform) }}
                            >
                              {ch.name.charAt(0).toUpperCase()}
                            </div>
                          )}
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
                      <td className="px-4 py-3 text-right">{formatNumber(ch.impressions)}</td>
                      <td className="px-4 py-3 text-right">{formatNumber(ch.reach)}</td>
                      <td className="px-4 py-3 text-right">{formatNumber(ch.likes)}</td>
                      <td className="px-4 py-3 text-right">{formatNumber(ch.comments)}</td>
                      <td className="px-4 py-3 text-right">{formatNumber(ch.shares)}</td>
                      <td className="px-4 py-3 text-right">
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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex h-48 items-center justify-center">
              <div className="text-center">
                <Users className="mx-auto h-8 w-8 text-muted-foreground/30" />
                <p className="mt-2 text-sm text-muted-foreground">No active channels found</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
