import { describe, it, expect } from "vitest";
import { addLocalClaim, releaseLocalClaim, localClaimCount } from "./local-claims";

describe("local-claims", () => {
  it("counts holders per target and never goes negative", () => {
    expect(localClaimCount("x")).toBe(0);
    addLocalClaim("x");
    addLocalClaim("x");
    expect(localClaimCount("x")).toBe(2);
    releaseLocalClaim("x");
    expect(localClaimCount("x")).toBe(1);
    releaseLocalClaim("x");
    releaseLocalClaim("x");
    expect(localClaimCount("x")).toBe(0);
    addLocalClaim("x");
    expect(localClaimCount("x")).toBe(1);
    releaseLocalClaim("x");
  });
});
