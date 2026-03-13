"use client";

import { useState } from "react";
import { RotateCw, Eye } from "lucide-react";
import { trpc } from "~/lib/trpc/client";
import { DataTable, type Column } from "~/components/admin/DataTable";
import { StatusBadge } from "~/components/admin/StatusBadge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useToast } from "~/hooks/use-toast";

const STATUSES = [
  "DRAFT",
  "SCHEDULED",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
  "CANCELLED",
] as const;

type PostRow = {
  id: string;
  content: string | null;
  status: string;
  createdAt: Date;
  organization: { id: string; name: string } | null;
  targets: Array<{
    id: string;
    status: string;
    channel: { id: string; name: string; platform: string } | null;
  }>;
};

export default function AdminPostsPage() {
  const { toast } = useToast();
  const [status, setStatus] = useState<string>("");
  const [organizationId, setOrganizationId] = useState<string>("");

  const { data, isLoading, refetch } = trpc.admin.posts.list.useQuery({
    status: (status as (typeof STATUSES)[number]) || undefined,
    organizationId: organizationId || undefined,
    limit: 50,
  });

  const retryFailed = trpc.admin.posts.retryFailed.useMutation({
    onSuccess: () => {
      refetch();
      toast({ title: "Post target queued for retry" });
    },
    onError: (err) =>
      toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const columns: Column<PostRow>[] = [
    {
      header: "Content",
      cell: (row) => (
        <p className="max-w-xs truncate text-sm">
          {row.content
            ? row.content.length > 60
              ? row.content.slice(0, 60) + "..."
              : row.content
            : "No content"}
        </p>
      ),
    },
    {
      header: "Organization",
      cell: (row) => (
        <span className="text-sm">{row.organization?.name ?? "N/A"}</span>
      ),
    },
    {
      header: "Status",
      cell: (row) => <StatusBadge status={row.status} />,
    },
    {
      header: "Platforms",
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.targets.map((t) => (
            <Badge key={t.id} variant="outline" className="text-xs">
              {t.channel?.platform ?? "?"}
            </Badge>
          ))}
        </div>
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
            title="View full content"
            onClick={() =>
              toast({
                title: "Post content",
                description: row.content ?? "No content",
              })
            }
          >
            <Eye className="h-4 w-4" />
          </Button>
          {row.status === "FAILED" &&
            row.targets
              .filter((t) => t.status === "FAILED")
              .map((t) => (
                <Button
                  key={t.id}
                  variant="ghost"
                  size="sm"
                  title={`Retry ${t.channel?.platform ?? "target"}`}
                  onClick={() => retryFailed.mutate({ postTargetId: t.id })}
                  disabled={retryFailed.isPending}
                >
                  <RotateCw className="mr-1 h-3 w-3" />
                  Retry
                </Button>
              ))}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Posts</h1>

      <div className="flex items-center gap-4">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={organizationId} onValueChange={setOrganizationId}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All organizations" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">All organizations</SelectItem>
            {/* Unique orgs from current data */}
            {data?.items
              ?.reduce<Array<{ id: string; name: string }>>((acc, post) => {
                if (
                  post.organization &&
                  !acc.find((o) => o.id === post.organization!.id)
                ) {
                  acc.push(post.organization);
                }
                return acc;
              }, [])
              .map((org) => (
                <SelectItem key={org.id} value={org.id}>
                  {org.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={(data?.items as PostRow[]) ?? []}
        isLoading={isLoading}
        hasMore={!!data?.nextCursor}
      />
    </div>
  );
}
