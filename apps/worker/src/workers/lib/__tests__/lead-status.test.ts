import { describe, it, expect } from "vitest";
import { reconcileLeadStatus } from "../lead-status";

describe("reconcileLeadStatus", () => {
  it("FAILED when a terminal message failed and no non-failed send remains", () => {
    expect(reconcileLeadStatus({ hasFailed: true, pendingCount: 0, sentCount: 0 })).toBe("FAILED");
  });
  it("SENT when nothing pending and at least one real send", () => {
    expect(reconcileLeadStatus({ hasFailed: false, pendingCount: 0, sentCount: 1 })).toBe("SENT");
  });
  it("null (no change) while sends are still pending", () => {
    expect(reconcileLeadStatus({ hasFailed: false, pendingCount: 2, sentCount: 0 })).toBeNull();
  });
  it("does NOT mark FAILED if a real send also succeeded on another channel", () => {
    expect(reconcileLeadStatus({ hasFailed: true, pendingCount: 0, sentCount: 1 })).toBe("SENT");
  });
  it("null when nothing pending, nothing sent, nothing failed (no-op)", () => {
    expect(reconcileLeadStatus({ hasFailed: false, pendingCount: 0, sentCount: 0 })).toBeNull();
  });
  it("null when pending even if a failure occurred (pending wins over failed)", () => {
    expect(reconcileLeadStatus({ hasFailed: true, pendingCount: 1, sentCount: 0 })).toBeNull();
  });
});
