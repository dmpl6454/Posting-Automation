"use client";

import { useState, useCallback } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Card } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { Separator } from "~/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Textarea } from "~/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  CheckCircle2,
  XCircle,
  Clock,
  MessageSquare,
  FileText,
} from "lucide-react";

type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(date).toLocaleDateString();
}

function getStatusBadge(status: string) {
  switch (status as ApprovalStatus) {
    case "PENDING":
      return (
        <Badge variant="outline" className="gap-1">
          <Clock className="h-3 w-3" />
          Pending
        </Badge>
      );
    case "APPROVED":
      return (
        <Badge variant="default" className="gap-1 bg-green-600">
          <CheckCircle2 className="h-3 w-3" />
          Approved
        </Badge>
      );
    case "REJECTED":
      return (
        <Badge variant="destructive" className="gap-1">
          <XCircle className="h-3 w-3" />
          Rejected
        </Badge>
      );
    case "CANCELLED":
      return (
        <Badge variant="secondary" className="gap-1">
          Cancelled
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function ApprovalsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [reviewDialog, setReviewDialog] = useState<{
    open: boolean;
    approvalRequestId: string;
    decision: "APPROVED" | "REJECTED";
  }>({ open: false, approvalRequestId: "", decision: "APPROVED" });
  const [comment, setComment] = useState("");

  const utils = trpc.useUtils();

  const filterInput =
    statusFilter === "all"
      ? { limit: 20 }
      : { status: statusFilter as ApprovalStatus, limit: 20 };

  const { data, isLoading } = trpc.approval.list.useQuery(filterInput);

  const reviewMutation = trpc.approval.review.useMutation({
    onSuccess: () => {
      utils.approval.list.invalidate();
      utils.notification.unreadCount.invalidate();
      setReviewDialog({ open: false, approvalRequestId: "", decision: "APPROVED" });
      setComment("");
    },
  });

  const pendingCount = data?.approvalRequests?.filter(
    (r) => (r.status as string) === "PENDING"
  ).length ?? 0;

  const handleOpenReviewDialog = useCallback(
    (approvalRequestId: string, decision: "APPROVED" | "REJECTED") => {
      setReviewDialog({ open: true, approvalRequestId, decision });
      setComment("");
    },
    []
  );

  const handleSubmitReview = useCallback(() => {
    reviewMutation.mutate({
      approvalRequestId: reviewDialog.approvalRequestId,
      decision: reviewDialog.decision,
      comment: comment || undefined,
    });
  }, [reviewMutation, reviewDialog, comment]);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Approvals</h1>
          {pendingCount > 0 && (
            <Badge variant="default">{pendingCount} pending</Badge>
          )}
        </div>

        <Select
          value={statusFilter}
          onValueChange={(value) => setStatusFilter(value)}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="PENDING">Pending</SelectItem>
            <SelectItem value="APPROVED">Approved</SelectItem>
            <SelectItem value="REJECTED">Rejected</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Separator />

      {/* Approval list */}
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
      ) : !data?.approvalRequests?.length ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FileText className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="text-lg font-medium">No approval requests</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {statusFilter === "all"
              ? "There are no approval requests assigned to you."
              : `No ${statusFilter.toLowerCase()} approval requests found.`}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {data.approvalRequests.map((approval) => {
            const isPending = (approval.status as string) === "PENDING";
            const currentStep = approval.steps.find(
              (s) => s.stepNumber === approval.currentStep
            );

            return (
              <Card key={approval.id} className="p-6">
                <div className="space-y-4">
                  {/* Header row */}
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        {getStatusBadge(approval.status)}
                        <span className="text-xs text-muted-foreground">
                          Step {approval.currentStep} of {approval.totalSteps}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Requested by{" "}
                        <span className="font-medium text-foreground">
                          {approval.requester?.name ||
                            approval.requester?.email ||
                            "Unknown"}
                        </span>{" "}
                        {formatTimeAgo(approval.createdAt)}
                      </p>
                    </div>
                  </div>

                  {/* Post content preview */}
                  {approval.post && (
                    <div className="rounded-md border bg-muted/30 p-4">
                      <p className="line-clamp-3 text-sm">
                        {approval.post.content}
                      </p>
                    </div>
                  )}

                  {/* Steps summary */}
                  <div className="flex flex-wrap items-center gap-2">
                    {approval.steps.map((step) => (
                      <div
                        key={step.id}
                        className="flex items-center gap-1 text-xs"
                      >
                        {(step.status as string) === "APPROVED" && (
                          <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                        )}
                        {(step.status as string) === "REJECTED" && (
                          <XCircle className="h-3.5 w-3.5 text-destructive" />
                        )}
                        {(step.status as string) === "PENDING" && (
                          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                        {(step.status as string) === "CANCELLED" && (
                          <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                        <span className="text-muted-foreground">
                          Step {step.stepNumber}
                        </span>
                        {step.comment && (
                          <MessageSquare className="h-3 w-3 text-muted-foreground" />
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Action buttons - only show for pending items where user is current reviewer */}
                  {isPending && currentStep && (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() =>
                          handleOpenReviewDialog(approval.id, "APPROVED")
                        }
                        className="gap-1 bg-green-600 hover:bg-green-700"
                      >
                        <CheckCircle2 className="h-4 w-4" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() =>
                          handleOpenReviewDialog(approval.id, "REJECTED")
                        }
                        className="gap-1"
                      >
                        <XCircle className="h-4 w-4" />
                        Reject
                      </Button>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Review dialog */}
      <Dialog
        open={reviewDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setReviewDialog({
              open: false,
              approvalRequestId: "",
              decision: "APPROVED",
            });
            setComment("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewDialog.decision === "APPROVED"
                ? "Approve Post"
                : "Reject Post"}
            </DialogTitle>
            <DialogDescription>
              {reviewDialog.decision === "APPROVED"
                ? "Are you sure you want to approve this post? Add an optional comment below."
                : "Are you sure you want to reject this post? Please provide a reason."}
            </DialogDescription>
          </DialogHeader>

          <Textarea
            placeholder={
              reviewDialog.decision === "APPROVED"
                ? "Optional comment..."
                : "Reason for rejection..."
            }
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
          />

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() =>
                setReviewDialog({
                  open: false,
                  approvalRequestId: "",
                  decision: "APPROVED",
                })
              }
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmitReview}
              disabled={reviewMutation.isPending}
              variant={
                reviewDialog.decision === "APPROVED" ? "default" : "destructive"
              }
              className={
                reviewDialog.decision === "APPROVED"
                  ? "bg-green-600 hover:bg-green-700"
                  : ""
              }
            >
              {reviewMutation.isPending
                ? "Submitting..."
                : reviewDialog.decision === "APPROVED"
                  ? "Approve"
                  : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
