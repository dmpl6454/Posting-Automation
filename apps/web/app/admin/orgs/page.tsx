"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { DataTable, type Column } from "~/components/admin/DataTable";
import { ConfirmDialog } from "~/components/admin/ConfirmDialog";
import { StatusBadge } from "~/components/admin/StatusBadge";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useDebounce } from "~/hooks/use-debounce";
import { useToast } from "~/hooks/use-toast";

type OrgRow = {
  id: string;
  name: string;
  slug: string;
  plan: string;
  createdAt: Date;
  _count: { members: number; posts: number; channels: number };
};

const PLANS = ["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"] as const;

export default function AdminOrgsPage() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);

  const { data, isLoading, refetch } = trpc.admin.orgs.list.useQuery({
    search: debouncedSearch || undefined,
    limit: 50,
  });

  const changePlan = trpc.admin.orgs.changePlan.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Plan updated" });
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteOrg = trpc.admin.orgs.delete.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Organization deleted" });
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const columns: Column<OrgRow>[] = [
    {
      header: "Name",
      cell: (row) => (
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="text-xs text-muted-foreground">{row.slug}</p>
        </div>
      ),
    },
    {
      header: "Plan",
      cell: (row) => <StatusBadge status={row.plan} />,
    },
    {
      header: "Members",
      cell: (row) => <span>{row._count.members}</span>,
    },
    {
      header: "Posts",
      cell: (row) => <span>{row._count.posts}</span>,
    },
    {
      header: "Channels",
      cell: (row) => <span>{row._count.channels}</span>,
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
        <div className="flex items-center gap-2">
          <Select
            defaultValue={row.plan}
            onValueChange={(plan) =>
              changePlan.mutate({
                organizationId: row.id,
                plan: plan as (typeof PLANS)[number],
              })
            }
          >
            <SelectTrigger className="h-8 w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLANS.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ConfirmDialog
            trigger={
              <Button variant="ghost" size="icon" title="Delete organization">
                <Trash2 className="h-4 w-4 text-red-500" />
              </Button>
            }
            title="Delete organization"
            description={`This will permanently delete "${row.name}" and all associated data. This action cannot be undone.`}
            confirmLabel="Delete"
            variant="destructive"
            onConfirm={() => deleteOrg.mutateAsync({ organizationId: row.id })}
          />
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Organizations</h1>
      <DataTable
        columns={columns}
        data={(data?.items as OrgRow[]) ?? []}
        searchPlaceholder="Search by name..."
        onSearch={setSearch}
        isLoading={isLoading}
        hasMore={!!data?.nextCursor}
      />
    </div>
  );
}
