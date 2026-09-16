import { describe, it, expect } from "vitest";
import {
  needsStoryFit,
  planStoryFit,
  storyFitKey,
  STORY_WIDTH,
  STORY_HEIGHT,
  STORY_ASPECT,
} from "./story-fit";

describe("needsStoryFit", () => {
  it("leaves 9:16 media alone, so a correct story keeps its byte-identical publish", () => {
    expect(needsStoryFit({ width: 1080, height: 1920 })).toBe(false);
    expect(needsStoryFit({ width: 720, height: 1280 })).toBe(false);
    expect(needsStoryFit({ width: 2160, height: 3840 })).toBe(false);
  });

  it("tolerates off-by-one rounding, which is not a visible shape difference", () => {
    expect(needsStoryFit({ width: 1080, height: 1919 })).toBe(false);
    expect(needsStoryFit({ width: 1079, height: 1920 })).toBe(false);
  });

  it("flags the shapes that actually crop on a phone", () => {
    expect(needsStoryFit({ width: 1080, height: 1350 })).toBe(true); // 4:5 — the reported case
    expect(needsStoryFit({ width: 1080, height: 1080 })).toBe(true); // square
    expect(needsStoryFit({ width: 1920, height: 1080 })).toBe(true); // landscape
    expect(needsStoryFit({ width: 1080, height: 2400 })).toBe(true); // taller than the canvas
  });

  it("does NOT re-render on an unusable probe — guessing is worse than publishing as-is", () => {
    expect(needsStoryFit(null)).toBe(false);
    expect(needsStoryFit(undefined)).toBe(false);
    expect(needsStoryFit({ width: 0, height: 0 })).toBe(false);
    expect(needsStoryFit({ width: NaN, height: 1920 })).toBe(false);
    expect(needsStoryFit({ width: -1080, height: 1920 })).toBe(false);
  });
});

describe("planStoryFit", () => {
  it("contains a 4:5 photo in full and pads above and below", () => {
    const plan = planStoryFit({ width: 1080, height: 1350 });
    expect(plan.canvas).toEqual({ width: STORY_WIDTH, height: STORY_HEIGHT });
    expect(plan.inner.width).toBe(1080);
    expect(plan.inner.height).toBe(1350);
    expect(plan.inner.left).toBe(0);
    expect(plan.inner.top).toBe(284); // (1920-1350)/2 = 285 → even
    expect(plan.padding).toBe("vertical");
  });

  it("pads at the sides when the source is TALLER than the canvas", () => {
    const plan = planStoryFit({ width: 1080, height: 2400 });
    expect(plan.inner.height).toBe(1920);
    expect(plan.inner.width).toBe(864);
    expect(plan.inner.top).toBe(0);
    expect(plan.inner.left).toBe(108);
    expect(plan.padding).toBe("horizontal");
  });

  it("never crops: the whole source fits inside the canvas at one scale", () => {
    for (const src of [
      { width: 4000, height: 3000 },
      { width: 1080, height: 1080 },
      { width: 640, height: 480 },
      { width: 1200, height: 628 },
      { width: 1080, height: 1350 },
    ]) {
      const plan = planStoryFit(src);
      expect(plan.inner.width).toBeLessThanOrEqual(STORY_WIDTH);
      expect(plan.inner.height).toBeLessThanOrEqual(STORY_HEIGHT);
      // Aspect preserved within a pixel of rounding.
      const srcRatio = src.width / src.height;
      const outRatio = plan.inner.width / plan.inner.height;
      expect(Math.abs(outRatio - srcRatio) / srcRatio).toBeLessThan(0.01);
      // Centred and inside the canvas.
      expect(plan.inner.left + plan.inner.width).toBeLessThanOrEqual(STORY_WIDTH);
      expect(plan.inner.top + plan.inner.height).toBeLessThanOrEqual(STORY_HEIGHT);
    }
  });

  it("returns EVEN dimensions and offsets — libx264 rejects odd ones", () => {
    for (const src of [
      { width: 1111, height: 999 },
      { width: 1080, height: 1351 },
      { width: 777, height: 1333 },
      { width: 4001, height: 2999 },
    ]) {
      const plan = planStoryFit(src);
      for (const n of [plan.inner.width, plan.inner.height, plan.inner.left, plan.inner.top]) {
        expect(n % 2, `${src.width}x${src.height} → ${n}`).toBe(0);
      }
    }
  });

  it("upscales a small source to fill the canvas width rather than sitting tiny in the middle", () => {
    const plan = planStoryFit({ width: 540, height: 675 }); // half-size 4:5
    expect(plan.inner.width).toBe(1080);
    expect(plan.inner.height).toBe(1350);
  });

  it("a 9:16 source maps to the full canvas (no padding), which is why fitting it is a no-op", () => {
    const plan = planStoryFit({ width: 1080, height: 1920 });
    expect(plan.inner).toEqual({ width: 1080, height: 1920, left: 0, top: 0 });
    expect(STORY_ASPECT).toBeCloseTo(0.5625, 6);
  });

  it("refuses dimensions it cannot lay out", () => {
    expect(() => planStoryFit({ width: 0, height: 100 })).toThrow(/positive finite/);
    expect(() => planStoryFit({ width: NaN, height: 100 })).toThrow(/positive finite/);
  });
});

describe("storyFitKey", () => {
  it("is keyed on the media id and a version, so one render serves the whole fan-out", () => {
    expect(storyFitKey("med_1")).toBe("story916:v1:med_1");
    expect(storyFitKey("med_1")).toBe(storyFitKey("med_1"));
    expect(storyFitKey("med_2")).not.toBe(storyFitKey("med_1"));
  });
});
