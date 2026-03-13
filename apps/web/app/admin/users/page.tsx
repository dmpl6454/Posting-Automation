"use client";

import { useState } from "react";
import {
  Shield,
  Ban,
  LogIn,
  Trash2,
} from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { DataTable, type Column } from "~/components/admin/DataTable";
import { ConfirmDialog } from "~/components/admin/ConfirmDialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useDebounce } from "~/hooks/use-debounce";
import { useToast } from "~/hooks/use-toast";

type UserRow = {
  id: string;
  name: string | null;
  email: string | null;
  isSuperAdmin: boolean;
  isBanned: boolean;
  createdAt: Date;
  _count: { memberships: number };
};

export default function AdminUsersPage() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);

  const { data, isLoading, refetch } = trpc.admin.users.list.useQuery({
    search: debouncedSearch || undefined,
    limit: 50,
  });

  const toggleAdmin = trpc.admin.users.toggleSuperAdmin.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Admin status updated" });
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const toggleBan = trpc.admin.users.toggleBan.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Ban status updated" });
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteUser = trpc.admin.users.delete.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "User deleted" });
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const impersonate = trpc.admin.users.impersonate.useMutation({
    onSuccess: (result) => {
      document.cookie = `admin-impersonate=${result.token}; path=/; max-age=3600`;
      window.location.href = "/dashboard";
    },
    onError: (err) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const columns: Column<UserRow>[] = [
    {
      header: "Name",
      cell: (row) => (
        <div>
          <p className="font-medium">{row.name ?? "No name"}</p>
          <p className="text-xs text-muted-foreground">{row.email}</p>
        </div>
      ),
    },
    {
      header: "Orgs",
      cell: (row) => <span>{row._count.memberships}</span>,
    },
    {
      header: "Role",
      cell: (row) => (
        <div className="flex gap-1">
          {row.isSuperAdmin && (
            <Badge variant="outline" className="border-red-200 bg-red-100 text-red-700">
              admin
            </Badge>
          )}
          {row.isBanned && (
            <Badge variant="outline" className="border-red-200 bg-red-100 text-red-700">
              banned
            </Badge>
          )}
          {!row.isSuperAdmin && !row.isBanned && (
            <Badge variant="outline">user</Badge>
          )}
        </div>
      ),
    },
    {
      header: "Joined",
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
            title="Toggle admin"
            onClick={() => toggleAdmin.mutate({ userId: row.id })}
          >
            <Shield className={`h-4 w-4 ${row.isSuperAdmin ? "text-red-600" : ""}`} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Toggle ban"
            onClick={() => toggleBan.mutate({ userId: row.id })}
          >
            <Ban className={`h-4 w-4 ${row.isBanned ? "text-red-600" : ""}`} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Impersonate"
            onClick={() => impersonate.mutate({ userId: row.id })}
          >
            <LogIn className="h-4 w-4" />
          </Button>
          <ConfirmDialog
            trigger={
              <Button variant="ghost" size="icon" title="Delete user">
                <Trash2 className="h-4 w-4 text-red-500" />
              </Button>
            }
            title="Delete user"
            description="This will soft-delete the user and remove all their memberships. This action cannot be undone."
            confirmLabel="Delete"
            variant="destructive"
            onConfirm={() => deleteUser.mutateAsync({ userId: row.id })}
          />
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Users</h1>
      <DataTable
        columns={columns}
        data={(data?.items as UserRow[]) ?? []}
        searchPlaceholder="Search by name or email..."
        onSearch={setSearch}
        isLoading={isLoading}
        hasMore={!!data?.nextCursor}
      />
    </div>
  );
}
