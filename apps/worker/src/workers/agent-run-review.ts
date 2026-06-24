/**
 * Review-gate decision for the agent-run path (Bug #2, 2026-06-24).
 *
 * Pure, side-effect-free so it can be unit-tested in isolation and shared by
 * the agent-run worker. Mirrors the content-generate worker's rule exactly:
 * auto-approval is governed ONLY by the account group's explicit
 * `skipReviewGate` opt-in. Everything else REVIEWS — i.e. lands in the Autopilot
 * Review Queue as a DRAFT and waits for human approval, instead of publishing
 * immediately the way the old agent-run worker did.
 */
export type AgentRunReviewDecision = {
  /** AutopilotPost.status to create the row with. */
  autopilotStatus: "APPROVED" | "REVIEWING";
  /** Post.status — SCHEDULED when auto-approved, DRAFT while awaiting review. */
  postStatus: "SCHEDULED" | "DRAFT";
  /** PostTarget.status — same gating as the post. */
  targetStatus: "SCHEDULED" | "DRAFT";
  /** Whether the worker should enqueue publish jobs now (only when approved). */
  publishNow: boolean;
};

export function resolveAgentRunReview(agent: {
  accountGroup?: { skipReviewGate?: boolean } | null;
}): AgentRunReviewDecision {
  const skipReview = agent.accountGroup?.skipReviewGate === true;
  return skipReview
    ? {
        autopilotStatus: "APPROVED",
        postStatus: "SCHEDULED",
        targetStatus: "SCHEDULED",
        publishNow: true,
      }
    : {
        autopilotStatus: "REVIEWING",
        postStatus: "DRAFT",
        targetStatus: "DRAFT",
        publishNow: false,
      };
}
