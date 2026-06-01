import { describe, it, expect } from "vitest";
import { buildShortDescription, assertShortDimensions } from "../providers/youtube.provider";

describe("buildShortDescription", () => {
  it("appends #Shorts when SHORT and not already present", () => {
    expect(buildShortDescription("my caption", true)).toBe("my caption\n#Shorts");
  });

  it("does not duplicate #Shorts when already present in the description", () => {
    expect(buildShortDescription("hello #Shorts", true)).toBe("hello #Shorts");
  });

  it("matches #shorts case-insensitively (no duplicate)", () => {
    expect(buildShortDescription("hello #shorts", true)).toBe("hello #shorts");
  });

  it("leaves the description untouched for non-Short videos", () => {
    expect(buildShortDescription("a landscape video", false)).toBe("a landscape video");
  });
});

describe("assertShortDimensions", () => {
  it("passes for a vertical, short video", () => {
    expect(() => assertShortDimensions({ width: 1080, height: 1920, durationSec: 30 })).not.toThrow();
  });

  it("passes for a square video at the duration limit", () => {
    expect(() => assertShortDimensions({ width: 1080, height: 1080, durationSec: 180 })).not.toThrow();
  });

  it("throws for a landscape video", () => {
    expect(() => assertShortDimensions({ width: 1920, height: 1080, durationSec: 30 }))
      .toThrow(/vertical/i);
  });

  it("throws for a video longer than 180s", () => {
    expect(() => assertShortDimensions({ width: 1080, height: 1920, durationSec: 200 }))
      .toThrow(/3 minutes|180/i);
  });

  it("includes the actual dimensions in the landscape error", () => {
    expect(() => assertShortDimensions({ width: 1920, height: 1080, durationSec: 30 }))
      .toThrow(/1920.*1080/);
  });
});
