"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import {
  PenSquare,
  Plus,
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { format } from "date-fns";

const statusConfig: Record<
  string,
  {
    color: string;
    variant: "default" | "secondary" | "destructive" | "outline";
    icon: any;
  }
> = {
  DRAFT: { color: "bg-gray-100 text-gray-700", variant: "secondary", icon: PenSquare },
  SCHEDULED: { color: "bg-blue-100 text-blue-700", variant: "outline", icon: Clock },
  PUBLISHING: { color: "bg-yellow-100 text-yellow-700", variant: "outline", icon: Loader2 },
  PUBLISHED: { color: "bg-green-100 text-green-700", variant: "default", icon: CheckCircle },
  FAILED: { color: "bg-red-100 text-red-700", variant: "destructive", icon: XCircle },
  CANCELLED: { color: "bg-gray-100 text-gray-500", variant: "secondary", icon: AlertCircle },
};

interface PostsTabProps {
  onSwitchTab?: (tab: string) => void;
}

export function PostsTab({ onSwitchTab }: PostsTabProps) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const { data, isLoading } = trpc.post.list.useQuery({
    status: statusFilter as any,
    limit: 20,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">All Posts</h2>
          <p className="text-sm text-muted-foreground">
            Manage and schedule your social media posts
          </p>
        </div>
        <Button onClick={() => onSwitchTab?.("compose")}>
          <Plus className="mr-2 h-4 w-4" />
          New Post
        </Button>
      </div>

      {/* Status filters */}
      <div className="flex flex-wrap gap-2">
        {["All", "DRAFT", "SCHEDULED", "PUBLISHED", "FAILED"].map((status) => {
          const isActive =
            (status === "All" && !statusFilter) || statusFilter === status;
          return (
            <Button
              key={status}
              variant={isActive ? "default" : "outline"}
              size="sm"
              onClick={() =>
                setStatusFilter(status === "All" ? undefined : status)
              }
            >
              {status === "All"
                ? status
                : status.charAt(0) + status.slice(1).toLowerCase()}
            </Button>
          );
        })}
      </div>

      {/* Posts list */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : data?.posts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16">
            <PenSquare className="h-12 w-12 text-muted-foreground/30" />
            <h3 className="mt-4 text-lg font-medium">No posts yet</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Create your first post to get started
            </p>
            <Button className="mt-4" onClick={() => onSwitchTab?.("compose")}>
              <Plus className="mr-2 h-4 w-4" />
              Create Post
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {data?.posts.map((post: any) => {
            const config = statusConfig[post.status] ?? statusConfig.DRAFT!;
            const StatusIcon = config!.icon;
            return (
              <div
                key={post.id}
                onClick={() => router.push(`/dashboard/posts/${post.id}`)}
                className="cursor-pointer"
              >
                <Card className="transition-colors hover:bg-muted/50">
                  <CardContent className="flex items-center gap-4 p-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                      <StatusIcon className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {post.content.slice(0, 100)}
                      </p>
                      <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                        <span>
                          {post.targets.length} channel
                          {post.targets.length !== 1 ? "s" : ""}
                        </span>
                        {post.scheduledAt && (
                          <span>
                            Scheduled:{" "}
                            {format(
                              new Date(post.scheduledAt),
                              "MMM d, yyyy h:mm a"
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                    <Badge variant={config.variant}>
                      {post.status.charAt(0) + post.status.slice(1).toLowerCase()}
                    </Badge>
                  </CardContent>
                </Card>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
