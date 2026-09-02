"use client";

import { trpc } from "~/lib/trpc/client";
import { Skeleton } from "~/components/ui/skeleton";
import { Activity } from "lucide-react";

/**
 * Design: run status is a tinted pill, in the mockup's literal hex. This
 * project's Tailwind config flattens the green/amber/red scales onto the
 * palette's status triplets, so a named shade here would render the pill's
 * text the same colour as its own background.
 */
const RUN_STYLE: Record<string, { label: string; className: string }> = {
  COMPLETED: { label: "Completed", className: "bg-[rgba(92,184,92,0.15)] text-[#5cb85c]" },
  COMPLETED_WITH_ERRORS: {
    label: "Completed with errors",
    className: "bg-[rgba(224,184,74,0.15)] text-[#e0b84a]",
  },
  RUNNING: { label: "Running", className: "bg-tile text-muted-foreground" },
  FAILED: { label: "Failed", className: "bg-[rgba(217,105,95,0.15)] text-[#d9695f]" },
  PENDING: { label: "Pending", className: "bg-tile text-faint" },
};

function RunStatusPill({ status }: { status: string }) {
  const s = RUN_STYLE[status] ?? {
    label: status,
    className: "bg-tile text-muted-foreground",
  };
  return (
    <span
      className={`shrink-0 rounded-full px-[11px] py-[3px] text-[10.5px] font-semibold leading-[1.6] ${s.className}`}
    >
      {s.label}
    </span>
  );
}

export default function PipelineLogsPage() {
  const { data, isLoading } = trpc.autopilot.pipelineRuns.useQuery({});

  const runs = (data as any[]) ?? [];

  return (
    <div className="space-y-4">
      {isLoading ? (
        <div className="flex flex-col gap-2.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[54px] w-full rounded-[12px]" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Activity className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="text-lg font-medium">No pipeline runs yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Pipeline run history will appear here once the autopilot has been
            triggered.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {runs.map((run: any) => (
            <div
              key={run.id}
              className="flex flex-wrap items-center gap-3.5 rounded-[12px] border border-border bg-card px-[18px] py-3.5"
            >
              {/* Status */}
              <RunStatusPill status={run.status} />

              {/* Timestamp */}
              <span className="text-[12px] leading-none text-muted-foreground">
                {new Date(run.startedAt ?? run.createdAt).toLocaleString()}
              </span>

              {/* Stats */}
              <div className="ml-auto flex flex-wrap items-center gap-3 text-[11px] leading-none text-faint">
                {run.itemsDiscovered != null && (
                  <span>Discovered: {run.itemsDiscovered}</span>
                )}
                {run.itemsScored != null && <span>Scored: {run.itemsScored}</span>}
                {run.postsGenerated != null && (
                  <span>Generated: {run.postsGenerated}</span>
                )}
                {run.postsApproved != null && (
                  <span>Approved: {run.postsApproved}</span>
                )}
                {run.postsScheduled != null && (
                  <span>Scheduled: {run.postsScheduled}</span>
                )}
                {run.postsFailed != null && run.postsFailed > 0 && (
                  <span className="font-medium text-[#d9695f]">
                    Failed: {run.postsFailed}
                  </span>
                )}
              </div>

              {/* Duration */}
              {run.completedAt && run.startedAt && (
                <span className="shrink-0 text-[11px] leading-none text-faint">
                  {Math.round(
                    (new Date(run.completedAt).getTime() -
                      new Date(run.startedAt).getTime()) /
                      1000
                  )}
                  s
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
