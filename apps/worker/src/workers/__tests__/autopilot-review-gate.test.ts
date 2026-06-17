import { describe, it, expect } from "vitest";

/** Mirror of content-generate.worker.ts:326-329 skipReview decision (AP-1 fix). */
function decideStatus(args: {
  skipReviewGate?: boolean | null;
  sensitivity: "LOW" | "MEDIUM" | "HIGH";
}): "APPROVED" | "REVIEWING" {
  const skipReview = args.skipReviewGate === true;
  return skipReview ? "APPROVED" : "REVIEWING";
}

describe("autopilot review gate (AP-1)", () => {
  it("LOW sensitivity does NOT auto-approve when skipReviewGate is off", () => {
    expect(decideStatus({ skipReviewGate: false, sensitivity: "LOW" })).toBe("REVIEWING");
    expect(decideStatus({ skipReviewGate: undefined, sensitivity: "LOW" })).toBe("REVIEWING");
    expect(decideStatus({ skipReviewGate: null, sensitivity: "LOW" })).toBe("REVIEWING");
  });
  it("still auto-approves when the explicit skipReviewGate is on", () => {
    expect(decideStatus({ skipReviewGate: true, sensitivity: "LOW" })).toBe("APPROVED");
    expect(decideStatus({ skipReviewGate: true, sensitivity: "HIGH" })).toBe("APPROVED");
  });
  it("HIGH/MEDIUM go to review unless explicitly skipped", () => {
    expect(decideStatus({ skipReviewGate: false, sensitivity: "HIGH" })).toBe("REVIEWING");
  });
});
