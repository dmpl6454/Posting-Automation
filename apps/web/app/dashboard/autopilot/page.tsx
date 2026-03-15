"use client";

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
  TrendingUp,
  ClipboardCheck,
  Send,
  Activity,
  Loader2,
  Zap,
} from "lucide-react";

export default function AutopilotOverviewPage() {
  const { data, isLoading } = trpc.autopilot.overview.useQuery();
  const utils = trpc.useUtils();

  const triggerMutation = trpc.autopilot.triggerPipeline.useMutation({
    onSuccess: () => {
      utils.autopilot.overview.invalidate();
      utils.autopilot.pipelineRuns.invalidate();
    },
  });

  const stats = [
    {
      title: "Trending Items",
      value: data?.trendingCount ?? 0,
      icon: TrendingUp,
      color: "text-blue-500",
    },
    {
      title: "Pending Review",
      value: data?.pendingReview ?? 0,
      icon: ClipboardCheck,
      color: "text-amber-500",
    },
    {
      title: "Posts Today",
      value: data?.postsToday ?? 0,
      icon: Send,
      color: "text-green-500",
    },
    {
      title: "Last Run Status",
      value: data?.latestRun?.status ?? "N/A",
      icon: Activity,
      color: "text-purple-500",
      isBadge: true,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Stat Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {stat.title}
              </CardTitle>
              <stat.icon className={`h-4 w-4 ${stat.color}`} />
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : stat.isBadge ? (
                <Badge
                  variant={
                    stat.value === "COMPLETED"
                      ? "default"
                      : stat.value === "FAILED"
                        ? "destructive"
                        : "secondary"
                  }
                >
                  {String(stat.value)}
                </Badge>
              ) : (
                <p className="text-2xl font-bold">{stat.value}</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Pipeline Trigger */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Run Pipeline</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            Manually trigger the autopilot pipeline to discover trending topics,
            generate content, and queue posts for review.
          </p>
          <Button
            onClick={() => triggerMutation.mutate()}
            disabled={triggerMutation.isPending}
            className="gap-2"
          >
            {triggerMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Zap className="h-4 w-4" />
            )}
            Run Pipeline Now
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
