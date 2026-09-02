"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "~/lib/trpc/client";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
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

/** `pill` = the status chip's fill + text; `tone` = the row icon's colour.
 *  These replaced the old light `color` swatches (bg-gray-100 …) and the shadcn
 *  Badge `variant`, neither of which read correctly on the dark surface. */
const statusConfig: Record<
  string,
  { icon: any; pill: string; tone: string }
> = {
  DRAFT: { icon: PenSquare, pill: "bg-tile text-muted-foreground", tone: "text-muted-foreground" },
  SCHEDULED: { icon: Clock, pill: "bg-gold/[0.12] text-gold", tone: "text-gold" },
  PUBLISHING: { icon: Loader2, pill: "bg-amber-500/15 text-amber-500", tone: "text-amber-500" },
  PUBLISHED: { icon: CheckCircle, pill: "bg-emerald-500/15 text-emerald-500", tone: "text-emerald-500" },
  FAILED: { icon: XCircle, pill: "bg-red-500/15 text-red-400", tone: "text-red-400" },
  CANCELLED: { icon: AlertCircle, pill: "bg-tile text-faint", tone: "text-faint" },
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
          <h2 className="text-[15px] font-medium leading-[1.2]">All Posts</h2>
          <p className="mt-1 text-[11.5px] leading-[1.45] text-muted-foreground">
            Manage and schedule your social media posts
          </p>
        </div>
        {/* The header "New Post" button was removed — the Compose tab at the top
            of Content Studio is the entry point for writing a post. The empty
            state below still offers its own create button. */}
      </div>

      {/* Status filters + sort — the same chip the rest of the studio uses:
          8px radius, 11.5px, gold-soft fill when active. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {["All", "DRAFT", "SCHEDULED", "PUBLISHED", "FAILED"].map((status) => {
          const isActive =
            !showArchived &&
            ((status === "All" && !statusFilter) || statusFilter === status);
          return (
            <button
              key={status}
              type="button"
              onClick={() => {
                setShowArchived(false);
                setStatusFilter(status === "All" ? undefined : status);
              }}
              className={`whitespace-nowrap rounded-[8px] border px-3 py-[7px] text-[11.5px] leading-none transition-all ${
                isActive
                  ? "border-[hsl(var(--accent-border))] bg-gold/[0.12] font-semibold text-gold"
                  : "border-transparent bg-tile font-medium text-muted-foreground hover:text-foreground"
              }`}
            >
              {status === "All"
                ? status
                : status.charAt(0) + status.slice(1).toLowerCase()}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => {
            setShowArchived(true);
            setStatusFilter(undefined);
          }}
          className={`flex items-center gap-1.5 whitespace-nowrap rounded-[8px] border px-3 py-[7px] text-[11.5px] leading-none transition-all ${
            showArchived
              ? "border-[hsl(var(--accent-border))] bg-gold/[0.12] font-semibold text-gold"
              : "border-transparent bg-tile font-medium text-muted-foreground hover:text-foreground"
          }`}
        >
          <Archive className="h-3 w-3" />
          Archived
        </button>
        <div className="ml-auto">
          <Select value={sort} onValueChange={(v) => setSort(v as SortOption)}>
            <SelectTrigger className="h-[34px] w-[160px] rounded-[8px] border-border2 bg-background text-[12px]" aria-label="Sort posts">
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
        <div className="space-y-2">
          {data?.posts.map((post: any) => {
            const config = statusConfig[post.status] ?? statusConfig.DRAFT!;
            const StatusIcon = config!.icon;
            return (
              /* One flat row instead of a nested Card: 32px status tile tinted
                 by state, 13px title, a single muted meta line, and a compact
                 status pill. The archive control only fades in on hover so the
                 resting list is just content — on touch (no hover) it stays
                 visible, since there is no way to reveal it there. */
              <div
                key={post.id}
                onClick={() => router.push(`/dashboard/posts/${post.id}`)}
                className="group flex cursor-pointer items-center gap-3 rounded-[12px] border border-border bg-card px-4 py-3 transition-colors hover:border-border2 hover:bg-hover"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-tile">
                  <StatusIcon className={`h-[14px] w-[14px] ${config.tone}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold leading-[1.35]">
                    {post.content.slice(0, 100)}
                  </p>
                  <p className="mt-1 truncate text-[11px] leading-none text-muted-foreground">
                    {post.targets.length} channel{post.targets.length !== 1 ? "s" : ""}
                    {post.scheduledAt && (
                      <>
                        <span className="px-1.5 text-faint">·</span>
                        {format(new Date(post.scheduledAt), "MMM d, yyyy · h:mm a")}
                      </>
                    )}
                  </p>
                </div>
                <span
                  className={`shrink-0 whitespace-nowrap rounded-[6px] px-2 py-[3px] text-[10px] font-semibold uppercase leading-[1.4] tracking-[0.06em] ${config.pill}`}
                >
                  {post.status.charAt(0) + post.status.slice(1).toLowerCase()}
                </span>
                {showArchived ? (
                  <button
                    type="button"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-all hover:bg-tile hover:text-foreground disabled:opacity-40 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                    title="Restore from archive"
                    disabled={unarchiveMut.isPending}
                    onClick={(e) => {
                      e.stopPropagation();
                      unarchiveMut.mutate({ id: post.id });
                    }}
                  >
                    <ArchiveRestore className="h-[14px] w-[14px]" />
                  </button>
                ) : canArchive(post.status) ? (
                  <button
                    type="button"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-all hover:bg-tile hover:text-foreground disabled:opacity-40 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                    title="Archive post"
                    disabled={archiveMut.isPending}
                    onClick={(e) => {
                      e.stopPropagation();
                      archiveMut.mutate({ id: post.id });
                    }}
                  >
                    <Archive className="h-[14px] w-[14px]" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
