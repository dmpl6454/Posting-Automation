import { describe, it, expect } from "vitest";
import { resolveAgentRunReview, type AgentRunReviewDecision } from "../agent-run-review";

/**
 * Bug #2 (2026-06-24): agent-run.worker used to create every generated post as
 * SCHEDULED and enqueue it for immediate publishing — it NEVER created an
 * AutopilotPost(REVIEWING) row, so the Autopilot Review Queue was permanently
 * empty for the agent-run path while posts still published. The UI promises
 * "Generate drafts → Review in the approvals queue → Post approved drafts".
 *
 * The fix routes agent-run posts through the SAME review gate the pipeline path
 * uses: REVIEWING by default, auto-APPROVED only when the agent's Account Group
 * has skipReviewGate === true. This test locks the decision logic.
 */
describe("resolveAgentRunReview", () => {
  it("requires review when the agent has no account group (default safe)", () => {
    const d: AgentRunReviewDecision = resolveAgentRunReview({ accountGroup: null });
    expect(d.autopilotStatus).toBe("REVIEWING");
    expect(d.publishNow).toBe(false);
    expect(d.postStatus).toBe("DRAFT");
    expect(d.targetStatus).toBe("DRAFT");
  });

  it("requires review when the account group has skipReviewGate=false", () => {
    const d = resolveAgentRunReview({ accountGroup: { skipReviewGate: false } });
    expect(d.autopilotStatus).toBe("REVIEWING");
    expect(d.publishNow).toBe(false);
    expect(d.postStatus).toBe("DRAFT");
    expect(d.targetStatus).toBe("DRAFT");
  });

  it("auto-approves + publishes when the account group opts into skipReviewGate", () => {
    const d = resolveAgentRunReview({ accountGroup: { skipReviewGate: true } });
    expect(d.autopilotStatus).toBe("APPROVED");
    expect(d.publishNow).toBe(true);
    expect(d.postStatus).toBe("SCHEDULED");
    expect(d.targetStatus).toBe("SCHEDULED");
  });

  it("treats a missing skipReviewGate flag as review-required", () => {
    const d = resolveAgentRunReview({ accountGroup: {} as any });
    expect(d.autopilotStatus).toBe("REVIEWING");
    expect(d.publishNow).toBe(false);
  });
});
