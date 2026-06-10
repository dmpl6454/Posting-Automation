import { describe, it, expect } from "vitest";
import { clampVideoDuration } from "../routers/repurpose.router";

describe("clampVideoDuration", () => {
  it("returns an in-range value unchanged", () => {
    expect(clampVideoDuration(6)).toBe(6);
    expect(clampVideoDuration(2)).toBe(2);
    expect(clampVideoDuration(12)).toBe(12);
  });

  it("defaults to 8 when nullish or 0", () => {
    expect(clampVideoDuration(0)).toBe(8);
    expect(clampVideoDuration(undefined)).toBe(8);
  });

  it("clamps above the max to 12", () => {
    expect(clampVideoDuration(20)).toBe(12);
  });

  it("clamps below the min to 2", () => {
    expect(clampVideoDuration(1)).toBe(2);
  });

  it("rounds before clamping", () => {
    // 8.6 → round 9 → in range → 9
    expect(clampVideoDuration(8.6)).toBe(9);
    // 11.9 → round 12 → in range → 12
    expect(clampVideoDuration(11.9)).toBe(12);
    // 12.4 → round 12 → in range → 12
    expect(clampVideoDuration(12.4)).toBe(12);
  });
});
