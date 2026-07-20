"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  PenSquare,
  Plus,
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  AlertCircle,
  Archive,
  ArchiveRestore,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "~/hooks/use-toast";
import { humanizeError } from "~/lib/errors";

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

type SortOption = "newest" | "oldest" | "recently_updated";

export function PostsTab({ onSwitchTab }: PostsTabProps) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [showArchived, setShowArchived] = useState(false);
  const [sort, setSort] = useState<SortOption>("newest");
  const { data, isLoading } = trpc.post.list.useQuery({
    status: statusFilter as any,
    limit: 20,
    archived: showArchived,
    sort,
  });

  const archiveMut = trpc.post.archive.useMutation({
    onSuccess: () => {
      utils.post.list.invalidate();
      toast({ title: "Post archived", description: "Find it under the Archived tab." });
    },
    onError: (err) => {
      toast({ title: "Couldn't archive", description: humanizeError(err), variant: "destructive" });
    },
  });
  const unarchiveMut = trpc.post.unarchive.useMutation({
    onSuccess: () => {
      utils.post.list.invalidate();
      toast({ title: "Post restored", description: "It's back in your posts list." });
    },
    onError: (err) => {
      toast({ title: "Couldn't restore", description: humanizeError(err), variant: "destructive" });
    },
  });
  // A SCHEDULED/PUBLISHING post still has live pipeline work — the backend
  // rejects archiving it; hide the button rather than surface an error.
  const canArchive = (status: string) => status !== "SCHEDULED" && status !== "PUBLISHING";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">All Posts</h2>
          <p className="text-sm text-muted-foreground">
            Manage and schedule your social media posts
          </p>
        </div>
        {!(data && data.posts.length === 0) && (
          <Button onClick={() => onSwitchTab?.("compose")}>
            <Plus className="mr-2 h-4 w-4" />
            New Post
          </Button>
        )}
      </div>

      {/* Status filters + sort */}
      <div className="flex flex-wrap items-center gap-2">
        {["All", "DRAFT", "SCHEDULED", "PUBLISHED", "FAILED"].map((status) => {
          const isActive =
            !showArchived &&
            ((status === "All" && !statusFilter) || statusFilter === status);
          return (
            <Button
              key={status}
              variant={isActive ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setShowArchived(false);
                setStatusFilter(status === "All" ? undefined : status);
              }}
            >
              {status === "All"
                ? status
                : status.charAt(0) + status.slice(1).toLowerCase()}
            </Button>
          );
        })}
        <Button
          variant={showArchived ? "default" : "outline"}
          size="sm"
          onClick={() => {
            setShowArchived(true);
            setStatusFilter(undefined);
          }}
        >
          <Archive className="mr-1.5 h-3.5 w-3.5" />
          Archived
        </Button>
        <div className="ml-auto">
          <Select value={sort} onValueChange={(v) => setSort(v as SortOption)}>
            <SelectTrigger className="h-8 w-[170px] text-xs" aria-label="Sort posts">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
              <SelectItem value="recently_updated">Recently updated</SelectItem>
            </SelectContent>
          </Select>
        </div>
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
            {showArchived ? (
              <>
                <Archive className="h-12 w-12 text-muted-foreground/30" />
                <h3 className="mt-4 text-lg font-medium">No archived posts</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Archive old posts from the list to tidy things up — they'll appear here.
                </p>
              </>
            ) : (
              <>
                <PenSquare className="h-12 w-12 text-muted-foreground/30" />
                <h3 className="mt-4 text-lg font-medium">No posts yet</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Create your first post to get started
                </p>
                <Button className="mt-4" onClick={() => onSwitchTab?.("compose")}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Post
                </Button>
              </>
            )}
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
                    {showArchived ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Restore from archive"
                        disabled={unarchiveMut.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          unarchiveMut.mutate({ id: post.id });
                        }}
                      >
                        <ArchiveRestore className="h-4 w-4" />
                      </Button>
                    ) : canArchive(post.status) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Archive post"
                        disabled={archiveMut.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          archiveMut.mutate({ id: post.id });
                        }}
                      >
                        <Archive className="h-4 w-4" />
                      </Button>
                    ) : null}
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
