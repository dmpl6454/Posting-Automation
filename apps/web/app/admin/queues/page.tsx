"use client";

import { humanizeError } from "~/lib/errors";

import { RotateCw, Trash2 } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { DataTable, type Column } from "~/components/admin/DataTable";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { useToast } from "~/hooks/use-toast";

type FailedJobRow = {
  id: string;
  queue: string;
  queueName: string;
  failedReason: string | null;
  attemptsMade: number;
  timestamp: number;
  finishedOn: number | null;
};

export default function AdminQueuesPage() {
  const { toast } = useToast();

  const { data: queueStats, isLoading: statsLoading } =
    trpc.admin.queues.stats.useQuery();
  const { data: failedJobs, isLoading: jobsLoading, refetch } =
    trpc.admin.queues.failedJobs.useQuery({ limit: 50 });

  const retryJob = trpc.admin.queues.retryJob.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Job queued for retry" });
    },
    onError: (err) =>
      toast({ title: "Error", description: humanizeError(err), variant: "destructive" }),
  });

  const deleteJob = trpc.admin.queues.deleteJob.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Job deleted" });
    },
    onError: (err) =>
      toast({ title: "Error", description: humanizeError(err), variant: "destructive" }),
  });

  const columns: Column<FailedJobRow>[] = [
    {
      header: "Queue",
      accessorKey: "queue",
    },
    {
      header: "Job ID",
      cell: (row) => (
        <span className="font-mono text-xs">{row.id}</span>
      ),
    },
    {
      header: "Failed Reason",
      cell: (row) => (
        <p className="max-w-xs truncate text-sm" title={row.failedReason ?? ""}>
          {row.failedReason
            ? row.failedReason.length > 80
              ? row.failedReason.slice(0, 80) + "..."
              : row.failedReason
            : "Unknown"}
        </p>
      ),
    },
    {
      header: "Attempts",
      cell: (row) => <span>{row.attemptsMade}</span>,
    },
    {
      header: "Time",
      cell: (row) => (
        <span className="text-sm text-muted-foreground">
          {row.finishedOn
            ? new Date(row.finishedOn).toLocaleString()
            : row.timestamp
              ? new Date(row.timestamp).toLocaleString()
              : "N/A"}
        </span>
      ),
    },
    {
      header: "Actions",
      cell: (row) => (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            title="Retry job"
            disabled={retryJob.isPending}
            onClick={() =>
              retryJob.mutate({ queueName: row.queueName, jobId: row.id })
            }
          >
            <RotateCw className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Delete job"
            disabled={deleteJob.isPending}
            onClick={() =>
              deleteJob.mutate({ queueName: row.queueName, jobId: row.id })
            }
          >
            <Trash2 className="h-4 w-4 text-[#d9695f]" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="w-full space-y-5">
      {/* Admin-console page header: plain bold title + sub (this module does
          not use the eyebrow/display headline the user-facing pages use). */}
      <div className="min-w-0">
        <h1 className="text-[29px] font-bold leading-[1.1] tracking-[-0.01em]">Queues</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          What the background workers are processing right now.
        </p>
      </div>

      {statsLoading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : queueStats ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Object.entries(queueStats).map(([name, counts]: [string, any]) => (
            <Card key={name}>
              <CardContent className="p-4">
                <p className="mb-2 font-mono text-xs font-semibold">{name}</p>
                {counts.error ? (
                  <p className="text-[11px] text-[#d9695f]">{counts.error}</p>
                ) : (
                  <div className="grid grid-cols-2 gap-1 text-xs">
                    <span className="text-[#e0b84a]">
                      {counts.waiting ?? 0} waiting
                    </span>
                    <span className="text-[#5b9bd5]">
                      {counts.active ?? 0} active
                    </span>
                    <span className="text-[#5cb85c]">
                      {counts.completed ?? 0} done
                    </span>
                    <span className="text-[#d9695f]">
                      {counts.failed ?? 0} failed
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      <div>
        <h2 className="mb-4 text-lg font-semibold">Failed Jobs</h2>
        <DataTable
          columns={columns}
          data={(failedJobs as FailedJobRow[]) ?? []}
          isLoading={jobsLoading}
        />
      </div>
    </div>
  );
}
