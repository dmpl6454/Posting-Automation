"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import {
  CheckCircle2,
  XCircle,
  FileText,
  Loader2,
  ImageIcon,
} from "lucide-react";

function sensitivityBadge(level: string | null | undefined) {
  switch (level) {
    case "HIGH":
      return <Badge variant="destructive">High</Badge>;
    case "MEDIUM":
      return <Badge variant="secondary">Medium</Badge>;
    case "LOW":
      return <Badge variant="outline">Low</Badge>;
    default:
      return null;
  }
}

export default function ReviewQueuePage() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.autopilot.reviewQueue.useQuery({});

  const approveMutation = trpc.autopilot.approvePost.useMutation({
    onSuccess: () => {
      utils.autopilot.reviewQueue.invalidate();
      utils.autopilot.overview.invalidate();
    },
  });

  const rejectMutation = trpc.autopilot.rejectPost.useMutation({
    onSuccess: () => {
      utils.autopilot.reviewQueue.invalidate();
      utils.autopilot.overview.invalidate();
    },
  });

  const bulkApproveMutation = trpc.autopilot.bulkApprove.useMutation({
    onSuccess: () => {
      setSelected(new Set());
      utils.autopilot.reviewQueue.invalidate();
      utils.autopilot.overview.invalidate();
    },
  });

  const bulkRejectMutation = trpc.autopilot.bulkReject.useMutation({
    onSuccess: () => {
      setSelected(new Set());
      utils.autopilot.reviewQueue.invalidate();
      utils.autopilot.overview.invalidate();
    },
  });

  const items = (data as any[]) ?? [];

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === items.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map((item: any) => item.id)));
    }
  };

  return (
    <div className="space-y-4">
      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border bg-muted/50 px-4 py-3">
          <span className="text-sm font-medium">
            {selected.size} selected
          </span>
          <Button
            size="sm"
            className="gap-1 bg-green-600 hover:bg-green-700"
            disabled={bulkApproveMutation.isPending}
            onClick={() =>
              bulkApproveMutation.mutate({
                autopilotPostIds: Array.from(selected),
              })
            }
          >
            {bulkApproveMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3 w-3" />
            )}
            Approve All
          </Button>
          <Button
            size="sm"
            variant="destructive"
            className="gap-1"
            disabled={bulkRejectMutation.isPending}
            onClick={() =>
              bulkRejectMutation.mutate({
                autopilotPostIds: Array.from(selected),
              })
            }
          >
            {bulkRejectMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <XCircle className="h-3 w-3" />
            )}
            Reject All
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {/* Select all toggle */}
      {items.length > 0 && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={toggleAll}>
            {selected.size === items.length ? "Deselect All" : "Select All"}
          </Button>
          <span className="text-sm text-muted-foreground">
            {items.length} item{items.length !== 1 ? "s" : ""} pending review
          </span>
        </div>
      )}

      {/* Loading state */}
      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="p-6">
              <div className="space-y-3">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-16 w-full" />
                <div className="flex gap-2">
                  <Skeleton className="h-8 w-20" />
                  <Skeleton className="h-8 w-20" />
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : items.length === 0 ? (
        /* Empty state */
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FileText className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="text-lg font-medium">No posts pending review</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            When the autopilot pipeline generates posts, they will appear here
            for your review.
          </p>
        </div>
      ) : (
        /* Review cards */
        <div className="space-y-4">
          {items.map((item: any) => {
            const isSelected = selected.has(item.id);
            return (
              <Card
                key={item.id}
                className={`p-6 transition-colors ${isSelected ? "ring-2 ring-primary" : ""}`}
              >
                <div className="space-y-4">
                  {/* Header */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => toggleSelect(item.id)}
                        className={`flex h-5 w-5 items-center justify-center rounded border transition-colors ${
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-muted-foreground/30"
                        }`}
                      >
                        {isSelected && (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <div>
                        <p className="text-sm font-medium">
                          {item.agent?.name ?? "Unknown Agent"}
                        </p>
                        {item.trendingItem && (
                          <p className="text-xs text-muted-foreground">
                            Trend score: {item.trendingItem.score}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {sensitivityBadge(item.sensitivityFlag)}
                    </div>
                  </div>

                  {/* Media preview */}
                  {item.post?.mediaAttachments?.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto">
                      {item.post.mediaAttachments
                        .slice(0, 3)
                        .map((media: any, idx: number) => (
                          <div
                            key={idx}
                            className="relative h-24 w-24 flex-shrink-0 overflow-hidden rounded-md border bg-muted"
                          >
                            {media.url ? (
                              <img
                                src={media.url}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center">
                                <ImageIcon className="h-6 w-6 text-muted-foreground/50" />
                              </div>
                            )}
                          </div>
                        ))}
                    </div>
                  )}

                  {/* Caption */}
                  {item.post?.content && (
                    <div className="rounded-md border bg-muted/30 p-4">
                      <p className="line-clamp-3 text-sm">
                        {item.post.content}
                      </p>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="gap-1 bg-green-600 hover:bg-green-700"
                      disabled={approveMutation.isPending}
                      onClick={() =>
                        approveMutation.mutate({ autopilotPostId: item.id })
                      }
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="gap-1"
                      disabled={rejectMutation.isPending}
                      onClick={() =>
                        rejectMutation.mutate({ autopilotPostId: item.id })
                      }
                    >
                      <XCircle className="h-4 w-4" />
                      Reject
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
