import { describe, expect, it } from "vitest";
import { styleNeedsAiBackground, capHookLine } from "../routers/repurpose.router";

describe("styleNeedsAiBackground", () => {
  it("text-only styles do NOT need an AI background", () => {
    expect(styleNeedsAiBackground("hook_bars")).toBe(false);
    expect(styleNeedsAiBackground("bold_typographic")).toBe(false);
  });

  it("photo styles DO need an AI background", () => {
    expect(styleNeedsAiBackground("premium_editorial")).toBe(true);
    expect(styleNeedsAiBackground("tweet_card")).toBe(true);
  });

  it("unknown styles default to needing an AI background (safe default)", () => {
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
