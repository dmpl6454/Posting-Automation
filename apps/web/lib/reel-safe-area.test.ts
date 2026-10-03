import { describe, it, expect } from "vitest";
import {
  REEL_FRAME_ASPECT,
  REEL_SAFE_ZONE,
  containedRect,
  isSingleReel,
  superTextScopeLabel,
} from "./reel-safe-area";

describe("REEL_SAFE_ZONE — Meta's published figures, not a guess", () => {
  it("is top 14 / bottom 35 / sides 6 on a 9:16 screen", () => {
    expect(REEL_SAFE_ZONE).toEqual({ topPct: 14, bottomPct: 35, sidePct: 6 });
    expect(REEL_FRAME_ASPECT).toBeCloseTo(9 / 16, 6);
  });
});

describe("containedRect — where the video sits inside the frame (object-fit: contain)", () => {
  it("a 9:16 video fills the 9:16 reel frame", () => {
    expect(containedRect(9 / 16, 9 / 16)).toEqual({ leftPct: 0, topPct: 0, widthPct: 100, heightPct: 100 });
  });

  it("a 4:5 video in the reel frame is letterboxed top and bottom, full width", () => {
    const r = containedRect(9 / 16, 4 / 5);
    expect(r.leftPct).toBe(0);
    expect(r.widthPct).toBe(100);
    // height = (9/16) / (4/5) = 0.703125
    expect(r.heightPct).toBeCloseTo(70.3125, 4);
    expect(r.topPct).toBeCloseTo((100 - 70.3125) / 2, 4);
  });

  it("a 9:16 video in a 16:9 player is pillarboxed, full height", () => {
    const r = containedRect(16 / 9, 9 / 16);
    expect(r.topPct).toBe(0);
    expect(r.heightPct).toBe(100);
    // width = (9/16) / (16/9) = 81/256
    expect(r.widthPct).toBeCloseTo((81 / 256) * 100, 4);
    expect(r.leftPct).toBeCloseTo((100 - (81 / 256) * 100) / 2, 4);
  });

  it("an unknown or invalid aspect assumes the video fills the frame", () => {
    for (const v of [null, undefined, 0, -1, NaN, Infinity]) {
      expect(containedRect(9 / 16, v as number)).toEqual({ leftPct: 0, topPct: 0, widthPct: 100, heightPct: 100 });
    }
  });

  it("the rect always stays inside the container", () => {
    for (const v of [0.2, 0.5, 9 / 16, 1, 4 / 3, 16 / 9, 3]) {
      for (const c of [9 / 16, 1, 16 / 9]) {
        const r = containedRect(c, v);
        expect(r.leftPct).toBeGreaterThanOrEqual(0);
        expect(r.topPct).toBeGreaterThanOrEqual(0);
        expect(r.leftPct + r.widthPct).toBeLessThanOrEqual(100.0001);
        expect(r.topPct + r.heightPct).toBeLessThanOrEqual(100.0001);
      }
    }
  });
});

describe("isSingleReel — only ONE video is a reel", () => {
  it("one video ⇒ reel; an image, two videos or nothing ⇒ not", () => {
    expect(isSingleReel(["a.mp4"], "video")).toBe(true);
    expect(isSingleReel(["a.jpg"], "image")).toBe(false);
    expect(isSingleReel(["a.mp4", "b.mp4"], "video")).toBe(false);
    expect(isSingleReel([], "video")).toBe(false);
    expect(isSingleReel(undefined, undefined)).toBe(false);
  });
});

describe("superTextScopeLabel — honest about where the strip appears", () => {
  it("names cover / intro / whole video; absent scope is the whole video", () => {
    expect(superTextScopeLabel({ scope: "cover" })).toBe("Super text · cover only");
    expect(superTextScopeLabel({ scope: "intro", introSeconds: 5 })).toBe("Super text · first 5s");
    expect(superTextScopeLabel({ scope: "intro" })).toBe("Super text · first 3s");
    expect(superTextScopeLabel({ scope: "video" })).toBe("Super text · whole video");
    expect(superTextScopeLabel({})).toBe("Super text · whole video");
    expect(superTextScopeLabel(null)).toBe("");
  });
});
