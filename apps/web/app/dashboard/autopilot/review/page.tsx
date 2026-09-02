"use client";

import { useState } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Check,
  CheckCircle2,
  XCircle,
  FileText,
  Loader2,
  ImageIcon,
  AlertTriangle,
} from "lucide-react";

/**
 * Design: approve/reject are filled action buttons in the mockup's own green
 * and terracotta, not the app's default primary/destructive variants. Literal
 * hex because this project's Tailwind config flattens the green/red scales.
 */
const APPROVE_BTN =
  "bg-[#5cb85c] text-[#0e0e0c] hover:bg-[#5cb85c] hover:brightness-110";
const REJECT_BTN =
  "bg-[#c96b56] text-[#1a1712] hover:bg-[#c96b56] hover:brightness-110";

function sensitivityPill(level: string | null | undefined) {
  if (!level) return null;
  const style =
    level === "HIGH"
      ? "bg-[rgba(217,105,95,0.15)] text-[#d9695f] border border-[rgba(217,105,95,0.3)]"
      : "bg-tile text-muted-foreground";
  return (
    <span
      className={`shrink-0 rounded-full px-[9px] py-0.5 text-[9.5px] font-semibold leading-[1.6] ${style}`}
    >
      {level.charAt(0) + level.slice(1).toLowerCase()}
    </span>
  );
}

export default function ReviewQueuePage() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.autopilot.reviewQueue.useQuery({});
  const { data: failedPosts } = trpc.autopilot.failedPosts.useQuery({});

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
      {/* Generation failures */}
      {failedPosts && failedPosts.length > 0 && (
        <div>
          <div className="flex items-center gap-[7px] text-[12.5px] font-semibold leading-none text-[#d9695f]">
            <AlertTriangle className="h-3.5 w-3.5" />
            Generation failures ({failedPosts.length})
          </div>
          <div className="mt-2.5 flex flex-col gap-2">
            {failedPosts.map((p: any) => (
              <div
                key={p.id}
                className="flex items-start justify-between gap-3.5 rounded-[10px] border border-[rgba(217,105,95,0.35)] bg-card px-4 py-3.5"
              >
                <div className="min-w-0">
                  <p className="break-words text-[12.5px] font-semibold leading-[1.4]">
                    {p.agent?.name ?? "Agent"} · {p.trendingItem?.title ?? "Untitled"}
                  </p>
                  {p.errorMessage && (
                    <p className="mt-[5px] break-words text-[11.5px] leading-[1.5] text-muted-foreground">
                      {p.errorMessage}
                    </p>
                  )}
                </div>
                <span className="shrink-0 rounded-full bg-[#d9695f] px-[11px] py-[3px] text-[10.5px] font-semibold leading-[1.6] text-[#1a1712]">
                  Failed
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Select all toggle */}
      {items.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-[8px] border-border2 bg-surface2 px-[13px] text-[12px] font-medium hover:bg-hover"
            onClick={toggleAll}
          >
            {selected.size === items.length ? "Deselect All" : "Select All"}
          </Button>
          <span className="text-[12.5px] leading-none text-muted-foreground">
            {items.length} item{items.length !== 1 ? "s" : ""} pending review
          </span>
        </div>
      )}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-border bg-surface1 px-4 py-3">
          <span className="text-[12.5px] font-medium leading-none">
            {selected.size} selected
          </span>
          <Button
            size="sm"
            className={`h-[30px] gap-1.5 rounded-[8px] px-3 text-[11.5px] font-semibold ${APPROVE_BTN}`}
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
            className={`h-[30px] gap-1.5 rounded-[8px] px-3 text-[11.5px] font-semibold ${REJECT_BTN}`}
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
          <Button
            size="sm"
            variant="ghost"
            className="h-[30px] rounded-[8px] px-3 text-[11.5px] font-medium text-muted-foreground"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
      )}

      {/* Loading state */}
      {isLoading ? (
        <div className="flex flex-col gap-3.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[210px] w-full rounded-[14px]" />
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
        <div className="flex flex-col gap-3.5">
          {items.map((item: any) => {
            const isSelected = selected.has(item.id);
            return (
              <div
                key={item.id}
                className={`rounded-[14px] border bg-card p-5 shadow-[0_8px_18px_-12px_rgba(0,0,0,.5)] transition-colors ${
                  isSelected ? "border-gold" : "border-border"
                }`}
              >
                {/* Header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => toggleSelect(item.id)}
                      className={`flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
                        isSelected
                          ? "border-gold bg-gold text-[hsl(var(--gold-foreground))]"
                          : "border-border2 bg-transparent"
                      }`}
                    >
                      {isSelected && <Check className="h-3 w-3" />}
                    </button>
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold leading-[1.3]">
                        {item.agent?.name ?? "Unknown Agent"}
                      </p>
                      {/* Field names read from the schema, not guessed: a
                          TrendingItem's column is `trendScore` and an
                          AutopilotPost's is `sensitivity`. The old markup read
                          `.score` and `.sensitivityFlag`, neither of which
                          exists — so the trend score printed "undefined" and
                          the sensitivity pill never rendered at all. */}
                      {item.trendingItem?.trendScore != null && (
                        <p className="mt-[3px] text-[11px] leading-[1.3] text-muted-foreground">
                          Trend score: {Math.round(item.trendingItem.trendScore)}
                        </p>
                      )}
                    </div>
                  </div>
                  {sensitivityPill(item.sensitivity)}
                </div>

                {/* Media preview */}
                {item.post?.mediaAttachments?.length > 0 && (
                  <div className="mt-3.5 flex gap-2 overflow-x-auto">
                    {item.post.mediaAttachments
                      .slice(0, 3)
                      .map((media: any, idx: number) => (
                        <div
                          key={idx}
                          className="relative h-24 w-24 flex-shrink-0 overflow-hidden rounded-[10px] border border-border bg-tile"
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
                  <div className="mt-3.5 rounded-[10px] border border-border bg-surface1 p-3.5">
                    <p className="line-clamp-3 break-words text-[12.5px] leading-[1.6]">
                      {item.post.content}
                    </p>
                  </div>
                )}

                {/* Actions */}
                <div className="mt-3.5 flex gap-2">
                  <Button
                    size="sm"
                    className={`h-8 gap-1.5 rounded-[8px] px-3.5 text-[12px] font-semibold ${APPROVE_BTN}`}
                    disabled={approveMutation.isPending}
                    onClick={() =>
                      approveMutation.mutate({ autopilotPostId: item.id })
                    }
                  >
                    <CheckCircle2 className="h-[13px] w-[13px]" />
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    className={`h-8 gap-1.5 rounded-[8px] px-3.5 text-[12px] font-semibold ${REJECT_BTN}`}
                    disabled={rejectMutation.isPending}
                    onClick={() =>
                      rejectMutation.mutate({ autopilotPostId: item.id })
                    }
                  >
                    <XCircle className="h-[13px] w-[13px]" />
                    Reject
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
