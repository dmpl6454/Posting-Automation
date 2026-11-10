import { describe, it, expect } from "vitest";
import { shouldReportJobFailure } from "./sentry";

describe("shouldReportJobFailure", () => {
  it("does not report a failure BullMQ will retry", () => {
    expect(shouldReportJobFailure({ attemptsMade: 1, opts: { attempts: 3 } }, new Error("x"))).toBe(false);
  });
  it("reports the final attempt", () => {
    expect(shouldReportJobFailure({ attemptsMade: 3, opts: { attempts: 3 } }, new Error("x"))).toBe(true);
    expect(shouldReportJobFailure({ attemptsMade: 1 }, new Error("x"))).toBe(true); // default 1 attempt
  });
  it("reports an UnrecoverableError at once (BullMQ never retries it)", () => {
    const e = new Error("refused");
    e.name = "UnrecoverableError";
    expect(shouldReportJobFailure({ attemptsMade: 1, opts: { attempts: 3 } }, e)).toBe(true);
  });
  it("reports a failure with no job attached", () => {
    expect(shouldReportJobFailure(undefined, new Error("x"))).toBe(true);
  });
});
