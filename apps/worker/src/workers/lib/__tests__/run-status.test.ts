import { describe, it, expect } from "vitest";
import { deriveRunStatus } from "../run-status";

describe("deriveRunStatus", () => {
  it("all failed → FAILED", () => {
    expect(deriveRunStatus({ postsGenerated: 0, postsFailed: 9 })).toBe("FAILED");
  });
  it("some failed, some generated → COMPLETED_WITH_ERRORS", () => {
    expect(deriveRunStatus({ postsGenerated: 5, postsFailed: 2 })).toBe("COMPLETED_WITH_ERRORS");
  });
  it("none failed → COMPLETED", () => {
    expect(deriveRunStatus({ postsGenerated: 5, postsFailed: 0 })).toBe("COMPLETED");
  });
  it("empty run (0/0) → COMPLETED (legit empty discovery)", () => {
    expect(deriveRunStatus({ postsGenerated: 0, postsFailed: 0 })).toBe("COMPLETED");
  });
});
