"use client";
import { RequireAppAdmin } from "~/components/auth/require-app-admin";

import { trpc } from "~/lib/trpc/client";
import { humanizeError } from "~/lib/errors";
import { useToast } from "~/hooks/use-toast";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  TrendingUp,
  ClipboardCheck,
  Send,
  Activity,
  Loader2,
  Zap,
  Info,
} from "lucide-react";

function AutopilotOverviewPageInner() {
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

  /*
   * Design: each stat card carries a 3px accent rail on its left edge and a
   * tinted icon tile in the same hue. The hues are literal hex from the mockup
   * — this project's Tailwind config FLATTENS the green/amber/blue scales onto
   * the palette's status triplets, so a named shade here would render the icon
   * the same colour as its own background.
   */
  const stats = [
    {
      title: "Trending Items",
      value: data?.trendingCount ?? 0,
      icon: TrendingUp,
      color: "#5b9bd5",
      tint: "rgba(91,155,213,0.12)",
    },
    {
      title: "Pending Review",
      value: data?.pendingReview ?? 0,
      icon: ClipboardCheck,
      color: "#e0b84a",
      tint: "rgba(224,184,74,0.12)",
    },
    {
      title: "Posts Today",
      value: data?.postsToday ?? 0,
      icon: Send,
      color: "#5cb85c",
      tint: "rgba(92,184,92,0.12)",
    },
    {
      title: "Last Run Status",
      value: data?.latestRun?.status ?? "N/A",
      icon: Activity,
      color: "hsl(var(--accent-gold))",
      tint: "hsl(var(--accent-gold) / 0.12)",
      isBadge: true,
    },
  ];

  return (
    <div className="space-y-5">
      {/* Fix #47: workflow guidance banner. Design: a plain surface-1 note, not
          the Alert component's heavier framing. */}
      <div className="flex items-start gap-3 rounded-[12px] border border-border bg-surface1 px-[18px] py-4">
        <Info className="mt-px h-4 w-4 shrink-0 text-gold" />
        <p className="text-[12.5px] leading-[1.7]">
          <strong>How Autopilot works:</strong> It runs in 4 stages —{" "}
          <strong>Discover</strong> trending topics →{" "}
          <strong>Generate</strong> drafts →{" "}
          <strong>Review</strong> in the Review Queue →{" "}
          <strong>Post</strong> approved drafts on schedule.
          Click <em>Run Pipeline Now</em> (or run an individual agent) to trigger
          a one-off run; the latest results appear in <em>Trending</em> and the{" "}
          <em>Review Queue</em>. Drafts wait there for your approval before
          publishing — unless an agent’s Account Group has <em>Skip review</em>{" "}
          turned on, in which case its posts publish automatically.
        </p>
      </div>

      {/* Stat Cards */}
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <div
            key={stat.title}
            className="relative overflow-hidden rounded-[14px] border border-border bg-card p-[18px] shadow-[0_8px_18px_-12px_rgba(0,0,0,.5)] transition-colors"
          >
            <span
              className="absolute left-0 top-0 h-full w-[3px]"
              style={{ background: stat.color }}
            />
            <div className="flex items-start justify-between gap-2.5">
              <span className="max-w-[110px] text-[11px] font-medium leading-[1.4] text-muted-foreground">
                {stat.title}
              </span>
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]"
                style={{ background: stat.tint }}
              >
                <stat.icon
                  className="h-[15px] w-[15px] shrink-0"
                  style={{ color: stat.color }}
                />
              </div>
            </div>
            {isLoading ? (
              <Skeleton className="mt-2.5 h-7 w-20" />
            ) : stat.isBadge ? (
              <span className="mt-3 inline-flex rounded-full border border-[hsl(var(--accent-border))] bg-gold/[0.12] px-3 py-1 text-[13px] font-semibold leading-none text-gold">
                {String(stat.value)}
              </span>
            ) : (
              <div className="mt-2.5 text-[28px] font-bold leading-none tracking-[-0.01em]">
                {stat.value}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Pipeline Trigger */}
      <div className="rounded-[14px] border border-border bg-card p-6 shadow-[0_10px_22px_-14px_rgba(0,0,0,.55)]">
        <div className="flex items-center gap-2.5">
          <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] border border-border2 bg-surface1">
            <Zap className="h-4 w-4 text-gold" />
          </div>
          <h2 className="text-[15px] font-medium leading-[1.2]">Run Pipeline</h2>
        </div>
        <p className="mt-2.5 text-[12.5px] leading-[1.5] text-muted-foreground">
          Manually trigger the autopilot pipeline to discover trending topics,
          generate content, and queue posts for review.
        </p>
        {/* Fix #52: spinner stays until run status leaves RUNNING */}
        <Button
          onClick={() => triggerMutation.mutate()}
          disabled={isRunning}
          className="pa-cta-gold mt-4 h-[38px] gap-2 rounded-[9px] px-4 text-[12.5px] font-semibold"
        >
          {isRunning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Zap className="h-3.5 w-3.5" />
          )}
          {isRunning ? "Pipeline Running…" : "Run Pipeline Now"}
        </Button>
      </div>
    </div>
  );
}

// App-level RBAC (2026-07-17): this page is an admin-only area. Server-side
// enforcement lives in tRPC (adminOrgProcedure); this wrapper only provides a
// clear "Admin access required" screen for USER-role deep links.
export default function AutopilotOverviewPage() {
  return (
    <RequireAppAdmin>
      <AutopilotOverviewPageInner />
    </RequireAppAdmin>
  );
}
