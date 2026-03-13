"use client";

import { Trash2, ImageIcon, HardDrive } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { DataTable, type Column } from "~/components/admin/DataTable";
import { ConfirmDialog } from "~/components/admin/ConfirmDialog";
import { StatCard } from "~/components/admin/StatCard";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { useToast } from "~/hooks/use-toast";

type MediaRow = {
  id: string;
  url: string;
  fileType: string;
  fileSize: number | null;
  createdAt: Date;
  organization: { id: string; name: string } | null;
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export default function AdminMediaPage() {
  const { toast } = useToast();

  const { data: storageStats, isLoading: statsLoading } =
    trpc.admin.media.storageStats.useQuery();
  const { data, isLoading, refetch } = trpc.admin.media.list.useQuery({
    limit: 50,
  });

  const deleteMedia = trpc.admin.media.delete.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Media deleted" });
    },
    onError: (err) =>
      toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const columns: Column<MediaRow>[] = [
    {
      header: "Thumbnail",
      cell: (row) => {
        const isImage = row.fileType?.startsWith("image");
        return isImage ? (
          <img
            src={row.url}
            alt="media"
            className="h-10 w-10 rounded object-cover"
          />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded bg-gray-100">
            <ImageIcon className="h-5 w-5 text-gray-400" />
          </div>
        );
      },
    },
    {
      header: "Organization",
      cell: (row) => (
        <span className="text-sm">{row.organization?.name ?? "N/A"}</span>
      ),
    },
    {
      header: "MIME Type",
      cell: (row) => (
        <Badge variant="outline" className="font-mono text-xs">
          {row.fileType ?? "unknown"}
        </Badge>
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
        <ConfirmDialog
          trigger={
            <Button variant="ghost" size="icon" title="Delete media">
              <Trash2 className="h-4 w-4 text-red-500" />
            </Button>
          }
          title="Delete media"
          description="This will permanently delete this media file from storage and the database. This action cannot be undone."
          confirmLabel="Delete"
          variant="destructive"
          onConfirm={() => deleteMedia.mutateAsync({ mediaId: row.id })}
        />
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Media</h1>

      {statsLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      ) : storageStats ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard
              title="Total Files"
              value={storageStats.totalCount}
              icon={ImageIcon}
            />
            <StatCard
              title="File Types"
              value={storageStats.byMimeType.length}
              icon={HardDrive}
              description={storageStats.byMimeType
                .map((t) => `${t.mimeType}: ${t.count}`)
                .join(", ")}
            />
            <StatCard
              title="Total Size"
              value={formatBytes(
                storageStats.byMimeType.reduce(
                  (acc, t) => acc + (t.totalSize ?? 0),
                  0
                )
              )}
              icon={HardDrive}
            />
          </div>
        </div>
      ) : null}

      <DataTable
        columns={columns}
        data={(data?.items as MediaRow[]) ?? []}
        isLoading={isLoading}
        hasMore={!!data?.nextCursor}
      />
    </div>
  );
}
