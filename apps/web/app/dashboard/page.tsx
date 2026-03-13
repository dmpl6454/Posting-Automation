"use client";

import Link from "next/link";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import {
  BarChart3,
  PenSquare,
  Share2,
  Sparkles,
  Plus,
  Calendar,
  TrendingUp,
  ArrowRight,
  Clock,
  CheckCircle,
  XCircle,
  ExternalLink,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export default function DashboardPage() {
  const { data: user, isLoading: userLoading } = trpc.user.me.useQuery();
  const { data: stats, isLoading: statsLoading } = trpc.analytics.dashboardStats.useQuery();
  const { data: activity, isLoading: activityLoading } = trpc.analytics.recentActivity.useQuery({ limit: 5 });

  const statItems = [
    { name: "Total Posts", value: stats?.totalPosts ?? 0, icon: PenSquare, color: "text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-950" },
    { name: "Connected Channels", value: stats?.connectedChannels ?? 0, icon: Share2, color: "text-green-600 bg-green-100 dark:text-green-400 dark:bg-green-950" },
    { name: "Published", value: stats?.published ?? 0, icon: BarChart3, color: "text-purple-600 bg-purple-100 dark:text-purple-400 dark:bg-purple-950" },
    { name: "AI Generated", value: stats?.aiGenerated ?? 0, icon: Sparkles, color: "text-orange-600 bg-orange-100 dark:text-orange-400 dark:bg-orange-950" },
  ];

  return (
    <div className="space-y-8">
      {/* Greeting */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {userLoading ? (
              <Skeleton className="h-8 w-48" />
            ) : (
              <>Welcome back{user?.name ? `, ${user.name}` : ""}</>
            )}
          </h1>
          <p className="mt-1 text-muted-foreground">
            Here&apos;s an overview of your social media activity.
          </p>
        </div>
        <Button asChild>
          <Link href="/dashboard/posts/new">
            <Plus className="mr-2 h-4 w-4" />
            Create Post
          </Link>
        </Button>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statsLoading
          ? [1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)
          : statItems.map((stat) => (
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

      {/* Quick Actions + Recent Activity */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Quick Actions */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
            <CardDescription>Get started with common tasks</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              <Link
                href="/dashboard/posts/new"
                className="group flex items-center gap-3 rounded-lg border p-4 transition-all hover:border-primary hover:bg-primary/5"
              >
                <div className="rounded-lg bg-primary/10 p-2.5 text-primary">
                  <PenSquare className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <p className="font-medium">Create Post</p>
                  <p className="text-xs text-muted-foreground">Write and schedule a new post</p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </Link>

              <Link
                href="/dashboard/channels"
                className="group flex items-center gap-3 rounded-lg border p-4 transition-all hover:border-primary hover:bg-primary/5"
              >
                <div className="rounded-lg bg-green-100 p-2.5 text-green-600 dark:bg-green-950 dark:text-green-400">
                  <Share2 className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <p className="font-medium">Connect Channel</p>
                  <p className="text-xs text-muted-foreground">Add a social media account</p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </Link>

              <Link
                href="/dashboard/content-agent"
                className="group flex items-center gap-3 rounded-lg border p-4 transition-all hover:border-primary hover:bg-primary/5"
              >
                <div className="rounded-lg bg-purple-100 p-2.5 text-purple-600 dark:bg-purple-950 dark:text-purple-400">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <p className="font-medium">Content Agent</p>
                  <p className="text-xs text-muted-foreground">Generate content with AI</p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </Link>

              <Link
                href="/dashboard/calendar"
                className="group flex items-center gap-3 rounded-lg border p-4 transition-all hover:border-primary hover:bg-primary/5"
              >
                <div className="rounded-lg bg-orange-100 p-2.5 text-orange-600 dark:bg-orange-950 dark:text-orange-400">
                  <Calendar className="h-5 w-5" />
                </div>
                <div className="flex-1">
                  <p className="font-medium">View Calendar</p>
                  <p className="text-xs text-muted-foreground">See your content schedule</p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </Link>
            </div>
          </CardContent>
        </Card>

        {/* Recent Activity */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              Recent Activity
            </CardTitle>
            <CardDescription>Latest publishing activity</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {activityLoading ? (
              [1, 2, 3].map((i) => <Skeleton key={i} className="h-14 rounded-lg" />)
            ) : activity && activity.length > 0 ? (
              activity.map((item: any) => (
                <div key={item.id} className="flex items-start gap-3 rounded-lg border p-3">
                  {item.status === "PUBLISHED" ? (
                    <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.postContent}</p>
                    <div className="mt-0.5 flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">{item.platform}</Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {formatDistanceToNow(new Date(item.timestamp), { addSuffix: true })}
                      </span>
                    </div>
                  </div>
                  {item.publishedUrl && (
                    <a href={item.publishedUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground hover:text-primary" />
                    </a>
                  )}
                </div>
              ))
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-3 rounded-lg border p-3">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</div>
                  <div className="flex-1">
                    <p className="text-sm font-medium">Connect a channel</p>
                    <p className="text-xs text-muted-foreground">Link your social accounts</p>
                  </div>
                  <Badge variant="outline"><Clock className="mr-1 h-3 w-3" />2 min</Badge>
                </div>
                <div className="flex items-center gap-3 rounded-lg border p-3">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-bold">2</div>
                  <div className="flex-1">
                    <p className="text-sm font-medium">Create your first post</p>
                    <p className="text-xs text-muted-foreground">Draft content for publishing</p>
                  </div>
                  <Badge variant="outline"><Clock className="mr-1 h-3 w-3" />3 min</Badge>
                </div>
                <div className="flex items-center gap-3 rounded-lg border p-3">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-bold">3</div>
                  <div className="flex-1">
                    <p className="text-sm font-medium">Try AI generation</p>
                    <p className="text-xs text-muted-foreground">Let AI write for you</p>
                  </div>
                  <Badge variant="outline"><Clock className="mr-1 h-3 w-3" />1 min</Badge>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
