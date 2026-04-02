"use client";

import { useParams } from "next/navigation";
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
import {
  Eye,
  MousePointerClick,
  TrendingUp,
  Users,
  DollarSign,
  Hash,
  Target,
  ArrowLeft,
  ExternalLink,
  BarChart3,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";

const statusColors: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  ACTIVE: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
  PAUSED: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  COMPLETED: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  ARCHIVED: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500",
};

export default function CampaignDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const { data: campaign, isLoading } = trpc.campaign.byId.useQuery({ id });
  const { data: metrics, isLoading: metricsLoading } = trpc.campaign.metrics.useQuery({ id });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  if (!campaign) return null;

  const engagementRate = metrics?.engagementRate?.toFixed(2) ?? "0";
  const ctr = metrics?.ctr?.toFixed(2) ?? "0";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <Link
          href="/dashboard/campaigns"
          className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Campaigns
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{campaign.name}</h1>
          <Badge className={`text-xs ${statusColors[campaign.status] ?? ""}`}>
            {campaign.status}
          </Badge>
        </div>
        {campaign.description && (
          <p className="mt-1 text-sm text-muted-foreground">{campaign.description}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {campaign.hashtags.map((tag) => (
            <Badge key={tag} variant="outline" className="text-xs">
              <Hash className="mr-1 h-3 w-3" />
              {tag}
            </Badge>
          ))}
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { title: "Impressions", value: (metrics?.totalImpressions ?? 0).toLocaleString(), icon: Eye, color: "text-blue-500" },
          { title: "Clicks", value: (metrics?.totalClicks ?? 0).toLocaleString(), icon: MousePointerClick, color: "text-emerald-500" },
          { title: "Engagements", value: (metrics?.totalEngagements ?? 0).toLocaleString(), icon: TrendingUp, color: "text-amber-500" },
          { title: "Reach", value: (metrics?.totalReach ?? 0).toLocaleString(), icon: Users, color: "text-violet-500" },
        ].map((stat) => (
          <Card key={stat.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {stat.title}
              </CardTitle>
              <stat.icon className={`h-4 w-4 ${stat.color}`} />
            </CardHeader>
            <CardContent>
              {metricsLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : (
                <p className="text-2xl font-bold">{stat.value}</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Performance Summary */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Engagement Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{engagementRate}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Click-Through Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{ctr}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Budget / Spend
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">
              ${(metrics?.totalSpend ?? 0).toLocaleString()}
              {campaign.budget && (
                <span className="text-base font-normal text-muted-foreground">
                  {" "}/ ${campaign.budget.toLocaleString()}
                </span>
              )}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tracking URLs */}
      {campaign.trackingUrls.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Tracking URLs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {campaign.trackingUrls.map((url, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline truncate"
                  >
                    {url}
                  </a>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Linked Posts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Tracked Posts ({campaign.campaignPosts.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {campaign.campaignPosts.length > 0 ? (
            <div className="space-y-3">
              {campaign.campaignPosts.map((cp) => (
                <div
                  key={cp.id}
                  className="flex items-start gap-3 rounded-xl border border-border/30 bg-background/40 p-3"
                >
                  {cp.post.mediaAttachments[0]?.media?.url && (
                    <img
                      src={cp.post.mediaAttachments[0].media.thumbnailUrl || cp.post.mediaAttachments[0].media.url}
                      alt=""
                      className="h-12 w-12 rounded-lg object-cover"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{cp.post.content.slice(0, 100)}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {cp.post.status}
                      </Badge>
                      {cp.post.targets.map((t) => (
                        <Badge key={t.id} variant="outline" className="text-[10px]">
                          {t.channel.platform}
                        </Badge>
                      ))}
                      <span className="text-[10px] text-muted-foreground">
                        {cp.impressions.toLocaleString()} impressions
                      </span>
                    </div>
                  </div>
                  {cp.post.targets[0]?.publishedUrl && (
                    <a
                      href={cp.post.targets[0].publishedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/50 hover:text-foreground" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <BarChart3 className="mx-auto h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">
                No posts linked to this campaign yet.
                Link posts from Content Studio to track their performance.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
