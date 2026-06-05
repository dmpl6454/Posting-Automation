"use client";

import { trpc } from "~/lib/trpc/client";
import { humanizeError } from "~/lib/errors";
import { useToast } from "~/hooks/use-toast";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { Alert, AlertDescription } from "~/components/ui/alert";
import {
  TrendingUp,
  ClipboardCheck,
  Send,
  Activity,
  Loader2,
  Zap,
  Info,
} from "lucide-react";

export default function AutopilotOverviewPage() {
  const { toast } = useToast();
  const { data, isLoading } = trpc.autopilot.overview.useQuery();
  const utils = trpc.useUtils();

  // Fix #52: poll the latest run status so the button spinner stays until the
  // pipeline actually completes, not just until the enqueue call returns.
  const { data: latestRun } = trpc.autopilot.pipelineRuns.useQuery(
    { limit: 1 },
    { refetchInterval: 5000 }
  );
  const latestRunStatus = latestRun?.[0]?.status;

  const triggerMutation = trpc.autopilot.triggerPipeline.useMutation({
    onSuccess: () => {
      utils.autopilot.overview.invalidate();
      utils.autopilot.pipelineRuns.invalidate();
    },
    // BUG-02: surface server errors (e.g. "No active agents configured…") that
    // were previously swallowed, leaving the click with no visible feedback.
    onError: (err) => {
      toast({
        title: "Could not run pipeline",
        description: humanizeError(err),
        variant: "destructive",
      });
    },
  });

  // Fix #52: button is disabled while the mutation is in-flight OR while the
  // latest run is still running
  const isRunning = triggerMutation.isPending || latestRunStatus === "RUNNING";

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
      {/* Fix #47: workflow guidance banner */}
      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          <strong>How Autopilot works:</strong> It runs in 4 stages —{" "}
          <strong>Discover</strong> trending topics →{" "}
          <strong>Generate</strong> drafts →{" "}
          <strong>Review</strong> in the approvals queue →{" "}
          <strong>Post</strong> approved drafts on schedule.
          Click <em>Run Pipeline Now</em> to trigger a one-off run; the latest
          results appear in <em>Trending</em> and <em>Approvals</em>.
        </AlertDescription>
      </Alert>

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
          {/* Fix #52: spinner stays until run status leaves RUNNING */}
          <Button
            onClick={() => triggerMutation.mutate()}
            disabled={isRunning}
            className="gap-2"
          >
            {isRunning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Zap className="h-4 w-4" />
            )}
            {isRunning ? "Pipeline Running…" : "Run Pipeline Now"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
