"use client";

import { useMemo, useState } from "react";
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
  Trash2,
} from "lucide-react";
import { ConfirmDialog } from "~/components/ui/confirm-dialog";
import { postDeleteSummary, deleteRequestToast } from "~/lib/platform-delete-view";
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
  const { data, isLoading } = trpc.post.list.useQuery(
    {
      status: statusFilter as any,
      limit: 20,
      archived: showArchived,
      sort,
    },
    {
      // Poll while a delete-from-platform request is running (2026-11-05).
      refetchInterval: (query) => {
        const posts = ((query as any).state?.data?.posts ?? []) as any[];
        return posts.some((p) => postDeleteSummary(p.targets ?? []).inProgress > 0) ? 4000 : false;
      },
    }
  );

  // Bulk "Delete from Facebook / Instagram" (2026-11-05). Only posts with a
  // published Facebook/Instagram channel can be selected.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const deletable = useMemo(() => {
    const m = new Map<string, ReturnType<typeof postDeleteSummary>>();
    for (const p of (data?.posts ?? []) as any[]) m.set(p.id, postDeleteSummary(p.targets ?? []));
    return m;
  }, [data?.posts]);
  const selectableIds = [...deletable.entries()].filter(([, s]) => s.requestable > 0).map(([id]) => id);
  const selectedIds = [...selected].filter((id) => (deletable.get(id)?.requestable ?? 0) > 0);
  const selectedChannelCount = selectedIds.reduce((n, id) => n + (deletable.get(id)?.requestable ?? 0), 0);
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const bulkDeleteMut = trpc.bulk.deleteFromPlatforms.useMutation({
    onSuccess: (summary) => {
      toast(deleteRequestToast(summary));
      setSelected(new Set());
      setConfirmBulkDelete(false);
      utils.post.list.invalidate();
    },
    onError: (err) => {
      toast({ title: "Couldn't start the delete", description: humanizeError(err), variant: "destructive" });
    },
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
                setSelected(new Set());
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
            setSelected(new Set());
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

      {/* Bulk delete from Facebook / Instagram (2026-11-05) */}
      {selectableIds.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-[10px] border border-border bg-surface1 px-3 py-2 text-[12px]"
          data-testid="bulk-platform-delete-bar"
        >
          {selectedIds.length === 0 ? (
            <>
              <span className="text-muted-foreground">
                Tick posts to delete them from Facebook and Instagram.
              </span>
              <button
                type="button"
                className="ml-auto text-[12px] font-medium text-muted-foreground hover:text-foreground"
                onClick={() => setSelected(new Set(selectableIds))}
              >
                Select all on this page ({selectableIds.length})
              </button>
            </>
          ) : (
            <>
              <span className="font-semibold">
                {selectedIds.length} post{selectedIds.length === 1 ? "" : "s"} selected
              </span>
              <span className="text-muted-foreground">
                · {selectedChannelCount} channel{selectedChannelCount === 1 ? "" : "s"}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setConfirmBulkDelete(true)}
                  disabled={bulkDeleteMut.isPending}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  Delete from Facebook/Instagram
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmBulkDelete}
        onOpenChange={setConfirmBulkDelete}
        title={`Delete ${selectedIds.length} post${selectedIds.length === 1 ? "" : "s"} from Facebook/Instagram?`}
        description={`This removes the live posts from ${selectedChannelCount} channel${selectedChannelCount === 1 ? "" : "s"}, including their likes and comments. It can't be undone. The posts and their history stay in PostAutomation. Other platforms are not touched.`}
        confirmLabel="Delete from platforms"
        isPending={bulkDeleteMut.isPending}
        onConfirm={() => bulkDeleteMut.mutate({ postIds: selectedIds })}
      />

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
            const del = deletable.get(post.id);
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
                {del && del.requestable > 0 ? (
                  <input
                    type="checkbox"
                    aria-label="Select for deleting from Facebook/Instagram"
                    className="h-4 w-4 shrink-0 cursor-pointer accent-[hsl(var(--destructive))]"
                    checked={selected.has(post.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleSelected(post.id)}
                  />
                ) : selectableIds.length > 0 ? (
                  <span className="h-4 w-4 shrink-0" aria-hidden />
                ) : null}
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-tile">
                  <StatusIcon className={`h-[14px] w-[14px] ${config.tone}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold leading-[1.35]">
                    {/* A story's note is optional, so the title must not be blank. */}
                    {post.content.slice(0, 100) ||
                      (post.targets.some((t: any) => t.format === "STORY")
                        ? "Story"
                        : "Untitled post")}
                  </p>
                  <p className="mt-1 truncate text-[11px] leading-none text-muted-foreground">
                    {post.targets.some((t: any) => t.format === "STORY") && (
                      <>
                        <span className="font-semibold text-foreground">Story</span>
                        <span className="px-1.5 text-faint">·</span>
                      </>
                    )}
                    {post.targets.length} channel{post.targets.length !== 1 ? "s" : ""}
                    {post.scheduledAt && (
                      <>
                        <span className="px-1.5 text-faint">·</span>
                        {format(new Date(post.scheduledAt), "MMM d, yyyy · h:mm a")}
                      </>
                    )}
                  </p>
                </div>
                {del && del.inProgress > 0 ? (
                  <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[10.5px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> Deleting
                  </span>
                ) : del && del.deleted > 0 ? (
                  <span className="shrink-0 whitespace-nowrap rounded-[6px] bg-red-500/15 px-2 py-[3px] text-[10px] font-semibold uppercase leading-[1.4] tracking-[0.06em] text-red-400">
                    {del.requestable > 0 ? `${del.deleted} deleted from platform` : "Deleted from platform"}
                  </span>
                ) : null}
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
