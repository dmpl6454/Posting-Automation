import { describe, expect, it } from "vitest";
import { styleNeedsAiBackground, capHookLine } from "../routers/repurpose.router";

describe("styleNeedsAiBackground", () => {
  // Product decision 2026-06-11: EVERY style now gets an AI background (hook_bars
  // and bold_typographic used to skip it and render on a flat near-white fill,
  // which read as "blank" — and left carousel body slides blank too).
  it("all styles need an AI background", () => {
    expect(styleNeedsAiBackground("hook_bars")).toBe(true);
    expect(styleNeedsAiBackground("bold_typographic")).toBe(true);
    expect(styleNeedsAiBackground("premium_editorial")).toBe(true);
    expect(styleNeedsAiBackground("tweet_card")).toBe(true);
    expect(styleNeedsAiBackground("anything_else")).toBe(true);
  });
});

describe("capHookLine", () => {
  it("caps a long hook to <=7 words", () => {
    const out = capHookLine(
      "This is a very long hook line that exceeds the seven word limit by a lot",
    );
    const words = out.trim().split(/\s+/).filter(Boolean);
    expect(words.length).toBeLessThanOrEqual(7);
  });

  it("caps to <=7 words while keeping balanced **...** markup (no dangling **)", () => {
    const out = capHookLine("Rebel **MPs** back the **BJP** move today now");
    const words = out.trim().split(/\s+/).filter(Boolean);
    expect(words.length).toBeLessThanOrEqual(7);
    // Even number of ** markers => no dangling single marker
    const markerCount = (out.match(/\*\*/g) || []).length;
    expect(markerCount % 2).toBe(0);
  });

  it("leaves a short hook unchanged", () => {
    expect(capHookLine("Short hook")).toBe("Short hook");
  });
});
