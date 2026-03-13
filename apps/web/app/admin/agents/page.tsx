"use client";

import { Power, Trash2 } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { DataTable, type Column } from "~/components/admin/DataTable";
import { ConfirmDialog } from "~/components/admin/ConfirmDialog";
import { StatusBadge } from "~/components/admin/StatusBadge";
import { Button } from "~/components/ui/button";
import { useToast } from "~/hooks/use-toast";

type AgentRow = {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  createdAt: Date;
  organization: { id: string; name: string } | null;
};

export default function AdminAgentsPage() {
  const { toast } = useToast();

  const { data, isLoading, refetch } = trpc.admin.agents.list.useQuery({
    limit: 50,
  });

  const toggleActive = trpc.admin.agents.toggleActive.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Agent status updated" });
    },
    onError: (err) =>
      toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteAgent = trpc.admin.agents.delete.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Agent deleted" });
    },
    onError: (err) =>
      toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const columns: Column<AgentRow>[] = [
    {
      header: "Name",
      accessorKey: "name",
    },
    {
      header: "Organization",
      cell: (row) => (
        <span className="text-sm">{row.organization?.name ?? "N/A"}</span>
      ),
    },
    {
      header: "Type",
      accessorKey: "type",
    },
    {
      header: "Active",
      cell: (row) => (
        <StatusBadge status={row.isActive ? "valid" : "expired"} />
      ),
    },
    {
      header: "Created",
      cell: (row) => (
        <span className="text-sm text-muted-foreground">
          {new Date(row.createdAt).toLocaleDateString()}
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
            title="Toggle active"
            onClick={() => toggleActive.mutate({ agentId: row.id })}
          >
            <Power
              className={`h-4 w-4 ${row.isActive ? "text-green-600" : "text-gray-400"}`}
            />
          </Button>
          <ConfirmDialog
            trigger={
              <Button variant="ghost" size="icon" title="Delete agent">
                <Trash2 className="h-4 w-4 text-red-500" />
              </Button>
            }
            title="Delete agent"
            description={`This will permanently delete "${row.name}". This action cannot be undone.`}
            confirmLabel="Delete"
            variant="destructive"
            onConfirm={() => deleteAgent.mutateAsync({ agentId: row.id })}
          />
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Agents</h1>
      <DataTable
        columns={columns}
        data={(data?.items as AgentRow[]) ?? []}
        isLoading={isLoading}
        hasMore={!!data?.nextCursor}
      />
    </div>
  );
}
