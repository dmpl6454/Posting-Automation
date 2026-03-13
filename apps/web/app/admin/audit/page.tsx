"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { DataTable, type Column } from "~/components/admin/DataTable";
import { Input } from "~/components/ui/input";
import { useDebounce } from "~/hooks/use-debounce";

type AuditRow = {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: Date;
  user: { id: string; name: string | null; email: string | null } | null;
  organization: { id: string; name: string } | null;
};

export default function AdminAuditPage() {
  const [actionFilter, setActionFilter] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const debouncedAction = useDebounce(actionFilter, 300);

  const { data, isLoading } = trpc.admin.audit.list.useQuery({
    action: debouncedAction || undefined,
    startDate: startDate ? new Date(startDate) : undefined,
    endDate: endDate ? new Date(endDate) : undefined,
    limit: 50,
  });

  const columns: Column<AuditRow>[] = [
    {
      header: "User",
      cell: (row) => (
        <span className="text-sm">
          {row.user?.name ?? row.user?.email ?? "System"}
        </span>
      ),
    },
    {
      header: "Action",
      cell: (row) => (
        <span className="font-mono text-xs">{row.action}</span>
      ),
    },
    {
      header: "Entity Type",
      cell: (row) => (
        <span className="text-sm">{row.entityType ?? "N/A"}</span>
      ),
    },
    {
      header: "Organization",
      cell: (row) => (
        <span className="text-sm">{row.organization?.name ?? "N/A"}</span>
      ),
    },
    {
      header: "Timestamp",
      cell: (row) => (
        <span className="text-sm text-muted-foreground">
          {new Date(row.createdAt).toLocaleString()}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Audit Log</h1>

      <div className="flex items-center gap-4">
        <Input
          placeholder="Filter by action..."
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="max-w-xs"
        />
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground">From:</label>
          <Input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-40"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground">To:</label>
          <Input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-40"
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        data={(data?.items as AuditRow[]) ?? []}
        isLoading={isLoading}
        hasMore={!!data?.nextCursor}
      />
    </div>
  );
}
