"use client";

import { trpc } from "~/lib/trpc/client";
import { Badge } from "~/components/ui/badge";
import { Card } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { Activity } from "lucide-react";

function runStatusBadge(status: string) {
  switch (status) {
    case "COMPLETED":
      return (
        <Badge variant="default" className="bg-green-600">
          Completed
        </Badge>
      );
    case "RUNNING":
      return <Badge variant="secondary">Running</Badge>;
    case "FAILED":
      return <Badge variant="destructive">Failed</Badge>;
    case "PENDING":
      return <Badge variant="outline">Pending</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function PipelineLogsPage() {
  const { data, isLoading } = trpc.autopilot.pipelineRuns.useQuery({});

  const runs = (data as any[]) ?? [];

  return (
    <div className="space-y-4">
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="p-4">
              <div className="flex items-center gap-4">
                <Skeleton className="h-6 w-20" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-60 ml-auto" />
              </div>
            </Card>
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
        <div className="space-y-3">
          {runs.map((run: any) => (
            <Card key={run.id} className="p-4">
              <div className="flex flex-wrap items-center gap-4">
                {/* Status */}
                {runStatusBadge(run.status)}

                {/* Timestamp */}
                <span className="text-sm text-muted-foreground">
                  {new Date(run.startedAt ?? run.createdAt).toLocaleString()}
                </span>

                {/* Stats */}
                <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  {run.discovered != null && (
                    <span>Discovered: {run.discovered}</span>
                  )}
                  {run.scored != null && <span>Scored: {run.scored}</span>}
                  {run.generated != null && (
                    <span>Generated: {run.generated}</span>
                  )}
                  {run.approved != null && (
                    <span>Approved: {run.approved}</span>
                  )}
                  {run.scheduled != null && (
                    <span>Scheduled: {run.scheduled}</span>
                  )}
                  {run.failed != null && run.failed > 0 && (
                    <span className="font-medium text-destructive">
                      Failed: {run.failed}
                    </span>
                  )}
                </div>

                {/* Duration */}
                {run.finishedAt && run.startedAt && (
                  <span className="text-xs text-muted-foreground">
                    {Math.round(
                      (new Date(run.finishedAt).getTime() -
                        new Date(run.startedAt).getTime()) /
                        1000
                    )}
                    s
                  </span>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
