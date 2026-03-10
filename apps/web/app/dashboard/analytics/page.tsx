"use client";

import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { Badge } from "~/components/ui/badge";
import { BarChart3, TrendingUp, CheckCircle, XCircle, Eye, Heart, MessageCircle, Share, MousePointerClick, Users, Percent } from "lucide-react";

function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
}

export default function AnalyticsPage() {
  const { data: overview, isLoading: overviewLoading } = trpc.analytics.overview.useQuery({});
  const { data: engagement, isLoading: engagementLoading } = trpc.analytics.engagement.useQuery({});
  const { data: platformBreakdown, isLoading: breakdownLoading } = trpc.analytics.platformBreakdown.useQuery();

  const stats = [
    { name: "Total Posts", value: overview?.totalPosts ?? 0, icon: BarChart3, color: "text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-950" },
    { name: "Total Targets", value: overview?.totalTargets ?? 0, icon: TrendingUp, color: "text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-950" },
    { name: "Published", value: overview?.published ?? 0, icon: CheckCircle, color: "text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-950" },
    { name: "Failed", value: overview?.failed ?? 0, icon: XCircle, color: "text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-950" },
  ];

  const engagementMetrics = [
    { label: "Impressions", value: engagement?.impressions ?? 0, icon: Eye, color: "text-blue-500" },
    { label: "Likes", value: engagement?.likes ?? 0, icon: Heart, color: "text-red-500" },
    { label: "Comments", value: engagement?.comments ?? 0, icon: MessageCircle, color: "text-green-500" },
    { label: "Shares", value: engagement?.shares ?? 0, icon: Share, color: "text-purple-500" },
    { label: "Clicks", value: engagement?.clicks ?? 0, icon: MousePointerClick, color: "text-orange-500" },
    { label: "Reach", value: engagement?.reach ?? 0, icon: Users, color: "text-cyan-500" },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <p className="text-muted-foreground">Track your social media performance across all platforms</p>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {overviewLoading
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
                      <p className="text-2xl font-bold">{stat.value}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Engagement Metrics */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Engagement Breakdown</CardTitle>
            <CardDescription>Interactions across your published content (last 30 days)</CardDescription>
          </CardHeader>
          <CardContent>
            {engagementLoading ? (
              <div className="grid grid-cols-2 gap-4">
                {[1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4">
                  {engagementMetrics.map((metric) => (
                    <div key={metric.label} className="flex items-center gap-3 rounded-lg border p-3">
                      <metric.icon className={`h-5 w-5 ${metric.color}`} />
                      <div>
                        <p className="text-xs text-muted-foreground">{metric.label}</p>
                        <p className="text-lg font-semibold">{formatNumber(metric.value)}</p>
                      </div>
                    </div>
                  ))}
                </div>
                {/* Engagement Rate */}
                <div className="mt-4 flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
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

        {/* Platform Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Platform Breakdown</CardTitle>
            <CardDescription>Published posts per platform</CardDescription>
          </CardHeader>
          <CardContent>
            {breakdownLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 rounded-lg" />)}
              </div>
            ) : platformBreakdown && platformBreakdown.length > 0 ? (
              <div className="space-y-3">
                {platformBreakdown.map((item) => {
                  const total = platformBreakdown.reduce((sum, p) => sum + p.count, 0);
                  const percentage = total > 0 ? (item.count / total) * 100 : 0;
                  return (
                    <div key={item.platform} className="space-y-1.5">
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-xs">{item.platform}</Badge>
                        </div>
                        <span className="font-medium">{item.count} posts</span>
                      </div>
                      <div className="h-2 rounded-full bg-muted">
                        <div
                          className="h-2 rounded-full bg-primary transition-all"
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex h-48 items-center justify-center rounded-lg border border-dashed">
                <div className="text-center">
                  <BarChart3 className="mx-auto h-8 w-8 text-muted-foreground/30" />
                  <p className="mt-2 text-sm text-muted-foreground">
                    Publish posts to see platform breakdown
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
