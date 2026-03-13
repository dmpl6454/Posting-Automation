"use client";

import { RefreshCw, Unplug } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { DataTable, type Column } from "~/components/admin/DataTable";
import { ConfirmDialog } from "~/components/admin/ConfirmDialog";
import { StatusBadge } from "~/components/admin/StatusBadge";
import { PlatformIcon } from "~/components/icons/platform-icons";
import { Button } from "~/components/ui/button";
import { useToast } from "~/hooks/use-toast";

type ChannelRow = {
  id: string;
  name: string;
  platform: string;
  tokenStatus: string;
  hasRefreshToken: boolean;
  createdAt: Date;
  organization: { id: string; name: string } | null;
};

export default function AdminChannelsPage() {
  const { toast } = useToast();

  const { data, isLoading, refetch } = trpc.admin.channels.list.useQuery({
    limit: 50,
  });

  const refreshToken = trpc.admin.channels.refreshToken.useMutation({
    onSuccess: (result) => {
      refetch();
      if (result.success) {
        toast({ title: "Token refreshed successfully" });
      } else {
        toast({
          title: "Refresh failed",
          description: result.message,
          variant: "destructive",
        });
      }
    },
    onError: (err) =>
      toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const disconnect = trpc.admin.channels.disconnect.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Channel disconnected" });
    },
    onError: (err) =>
      toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const columns: Column<ChannelRow>[] = [
    {
      header: "Platform",
      cell: (row) => <PlatformIcon platform={row.platform} size="sm" />,
    },
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
      header: "Token Status",
      cell: (row) => <StatusBadge status={row.tokenStatus} />,
    },
    {
      header: "Refresh Token",
      cell: (row) => (
        <span className={`text-sm ${row.hasRefreshToken ? "text-green-600" : "text-gray-400"}`}>
          {row.hasRefreshToken ? "Yes" : "No"}
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
            title="Refresh token"
            disabled={!row.hasRefreshToken || refreshToken.isPending}
            onClick={() => refreshToken.mutate({ channelId: row.id })}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <ConfirmDialog
            trigger={
              <Button variant="ghost" size="icon" title="Disconnect channel">
                <Unplug className="h-4 w-4 text-red-500" />
              </Button>
            }
            title="Disconnect channel"
            description={`This will permanently disconnect "${row.name}" and remove it. This cannot be undone.`}
            confirmLabel="Disconnect"
            variant="destructive"
            onConfirm={async () => { await disconnect.mutateAsync({ channelId: row.id }); }}
          />
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Channels</h1>
      <DataTable
        columns={columns}
        data={(data?.items as ChannelRow[]) ?? []}
        isLoading={isLoading}
        hasMore={!!data?.nextCursor}
      />
    </div>
  );
}
