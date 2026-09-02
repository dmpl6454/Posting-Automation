"use client";
import { RequireAppAdmin } from "~/components/auth/require-app-admin";

import { useState, useCallback } from "react";
import { trpc } from "~/lib/trpc/client";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
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
  CheckCircle2,
  XCircle,
  Clock,
  MessageSquare,
  FileText,
  Info,
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

/**
 * Design: each approval card carries a 3px status-coloured left edge and a
 * matching tinted status pill.
 *
 * Literal hex throughout — this project's Tailwind config FLATTENS the
 * green/red/amber scales onto the palette's status triplets, so a named shade
 * would render a pill's label the same colour as its own background.
 *
 * ⚠️ `edge` is deliberately brighter than `pill`: the mockup uses the saturated
 * #eab308 / #22c55e / #ef4444 for the card's left rail and the muted palette
 * hues inside the pill. The rail is a 3px scan cue read from across the page;
 * the pill sits next to body text.
 */
const APPROVAL_STATUS: Record<
  string,
  { label: string; Icon: typeof Clock; pill: string; edge: string }
> = {
  PENDING:   { label: "Pending",   Icon: Clock,        pill: "bg-[rgba(224,184,74,0.15)] text-[#e0b84a]", edge: "#eab308" },
  APPROVED:  { label: "Approved",  Icon: CheckCircle2, pill: "bg-[rgba(92,184,92,0.15)] text-[#5cb85c]",  edge: "#22c55e" },
  REJECTED:  { label: "Rejected",  Icon: XCircle,      pill: "bg-[rgba(217,105,95,0.15)] text-[#d9695f]", edge: "#ef4444" },
  CANCELLED: { label: "Cancelled", Icon: XCircle,      pill: "bg-tile text-muted-foreground",             edge: "hsl(var(--border-2))" },
};

const STATUS_TABS = [
  { key: "all", label: "All" },
  { key: "PENDING", label: "Pending" },
  { key: "APPROVED", label: "Approved" },
  { key: "REJECTED", label: "Rejected" },
] as const;

function ApprovalsPageInner() {
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
    /* Design stacks sections on 20px, not 24px. */
    <div className="space-y-5">
      {/* Page header — design: the status filter is NOT here; it is the
          segmented row below the note, so the headline block stays clean. */}
      <div className="min-w-0">
        <span className="eyebrow">Approvals</span>
        <div className="mt-2.5 flex flex-wrap items-center gap-3">
          <h1 className="display text-[30px] leading-[1.1]">
            Give every post a second look.
          </h1>
          {pendingCount > 0 && (
            /* Design: pending count is a gold pill beside the headline. */
            <span className="pa-gold-glow rounded-full bg-gold px-2.5 py-[3px] text-[11.5px] font-bold leading-[1.6] text-[color:hsl(var(--gold-foreground))]">
              {pendingCount} pending
            </span>
          )}
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          Posts from Autopilot, scheduled content, or restricted roles land here for review
        </p>
      </div>

      {/* Design: a quiet surface-1 note, not the Alert component's framing. */}
      <div className="flex items-start gap-3 rounded-[12px] border border-border bg-surface1 px-4 py-3.5">
        <Info className="mt-px h-[15px] w-[15px] shrink-0 text-muted-foreground" />
        <p className="text-[12px] leading-[1.65] text-muted-foreground">
          Approve to send a post to the publishing queue, or reject with a comment to send it back
          for edits.
        </p>
      </div>

      {/* Status filter — design: a 4-up segmented row on a surface-1 track.
          The active pill is the gold-SOFT treatment (tinted fill + gold border
          + gold label), not the solid gold fill the sub-tabs elsewhere use. */}
      <div
        role="tablist"
        className="grid grid-cols-2 gap-1 rounded-[11px] border border-border bg-surface1 p-1 sm:grid-cols-4"
      >
        {STATUS_TABS.map((t) => {
          const on = statusFilter === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={on}
              onClick={() => setStatusFilter(t.key)}
              className={`flex h-8 items-center justify-center whitespace-nowrap rounded-[8px] px-3.5 text-[12px] font-medium transition-colors ${
                on
                  ? "border border-[hsl(var(--accent-border))] bg-gold/[0.12] text-gold"
                  : "border border-transparent text-muted-foreground hover:bg-hover hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Approval list */}
      {isLoading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[188px] w-full rounded-[14px]" />
          ))}
        </div>
      ) : !data?.approvalRequests?.length ? (
        <div className="flex flex-col items-center justify-center rounded-[14px] border border-border bg-card px-4 py-14 text-center">
          <FileText className="mb-4 h-12 w-12 text-muted-foreground/40" />
          <h3 className="text-[15px] font-semibold">No approval requests</h3>
          <p className="mt-1 max-w-md text-[12.5px] leading-[1.5] text-muted-foreground">
            {statusFilter === "all"
              ? "Nothing to review right now. Posts sent for approval — by Autopilot, scheduled content, or teammates with restricted roles — will appear here, and you'll be notified when one needs your review."
              : `No ${statusFilter.toLowerCase()} approval requests found.`}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {data.approvalRequests.map((approval) => {
            const isPending = (approval.status as string) === "PENDING";
            const currentStep = approval.steps.find(
              (s) => s.stepNumber === approval.currentStep
            );
            const st = APPROVAL_STATUS[approval.status] ?? APPROVAL_STATUS.CANCELLED!;

            return (
              <div
                key={approval.id}
                className="rounded-[14px] border border-border bg-card p-[18px] shadow-[0_8px_18px_-12px_rgba(0,0,0,.5)]"
                style={{ borderLeft: `3px solid ${st.edge}` }}
              >
                {/* Header row */}
                <div className="flex flex-wrap items-center justify-between gap-2.5">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`flex shrink-0 items-center gap-[5px] rounded-full px-2.5 py-[3px] text-[10.5px] font-semibold leading-[1.6] ${st.pill}`}
                    >
                      <st.Icon className="h-[11px] w-[11px]" />
                      {st.label}
                    </span>
                    <span className="text-[11px] leading-none text-faint">
                      Step {approval.currentStep} of {approval.totalSteps}
                    </span>
                  </div>
                  {/* Design puts requester and age on one muted line at the right. */}
                  <span className="text-[12px] leading-none text-muted-foreground">
                    {approval.requester?.name || approval.requester?.email || "Unknown"}
                    {" · "}
                    {formatTimeAgo(approval.createdAt)}
                  </span>
                </div>

                {/* Post content preview */}
                {approval.post && (
                  <div className="mt-3 rounded-[10px] border border-border2 bg-surface1 px-3.5 py-3">
                    <p className="line-clamp-3 text-[13px] leading-[1.55]">
                      {approval.post.content}
                    </p>
                  </div>
                )}

                {/* Steps summary. Not in the mockup, but kept: the header line
                    says WHICH step is current, this says what happened at each
                    one (and flags a reviewer's comment) — dropping it would
                    lose the only per-step record on the page. */}
                {approval.steps.length > 1 && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    {approval.steps.map((step) => {
                      const ss = step.status as string;
                      return (
                        <span
                          key={step.id}
                          className="flex items-center gap-1 text-[11px] leading-none text-faint"
                        >
                          {ss === "APPROVED" && <CheckCircle2 className="h-3 w-3 text-[#5cb85c]" />}
                          {ss === "REJECTED" && <XCircle className="h-3 w-3 text-[#d9695f]" />}
                          {ss === "PENDING" && <Clock className="h-3 w-3 text-muted-foreground" />}
                          {ss === "CANCELLED" && <XCircle className="h-3 w-3 text-faint" />}
                          Step {step.stepNumber}
                          {step.comment && <MessageSquare className="h-3 w-3" />}
                        </span>
                      );
                    })}
                  </div>
                )}

                {/* Action buttons — only for pending items where the user is the
                    current reviewer. Design: tinted outline buttons, not solid
                    fills; this page is a review queue, so neither choice should
                    shout louder than the other. */}
                {isPending && currentStep && (
                  <div className="mt-3 flex gap-2.5">
                    <Button
                      size="sm"
                      onClick={() => handleOpenReviewDialog(approval.id, "APPROVED")}
                      className="h-8 gap-1.5 rounded-[8px] border border-[rgba(92,184,92,0.3)] bg-[rgba(92,184,92,0.15)] px-3.5 text-[12px] font-semibold text-[#5cb85c] hover:bg-[rgba(92,184,92,0.15)] hover:opacity-85"
                    >
                      <CheckCircle2 className="h-[13px] w-[13px]" />
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => handleOpenReviewDialog(approval.id, "REJECTED")}
                      className="h-8 gap-1.5 rounded-[8px] border border-[rgba(217,105,95,0.3)] bg-[rgba(217,105,95,0.15)] px-3.5 text-[12px] font-semibold text-[#d9695f] hover:bg-[rgba(217,105,95,0.15)] hover:opacity-85"
                    >
                      <XCircle className="h-[13px] w-[13px]" />
                      Reject
                    </Button>
                  </div>
                )}
              </div>
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
              className={
                reviewDialog.decision === "APPROVED"
                  ? "border border-[rgba(92,184,92,0.3)] bg-[rgba(92,184,92,0.15)] font-semibold text-[#5cb85c] hover:bg-[rgba(92,184,92,0.15)] hover:opacity-85"
                  : "border border-[rgba(217,105,95,0.3)] bg-[rgba(217,105,95,0.15)] font-semibold text-[#d9695f] hover:bg-[rgba(217,105,95,0.15)] hover:opacity-85"
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

// App-level RBAC (2026-07-17): this page is an admin-only area. Server-side
// enforcement lives in tRPC (adminOrgProcedure); this wrapper only provides a
// clear "Admin access required" screen for USER-role deep links.
export default function ApprovalsPage() {
  return (
    <RequireAppAdmin>
      <ApprovalsPageInner />
    </RequireAppAdmin>
  );
}
