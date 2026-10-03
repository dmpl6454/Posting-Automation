import { describe, it, expect } from "vitest";
import type { SuperTextConfig } from "@postautomation/super-text";
import {
  assignVariantIndexes,
  baseTextOf,
  buildSuperTextVariantPrompt,
  maxSuperTextVariants,
  normalizeVariantText,
  parseVariantArray,
  sanitizeVariantTexts,
  variantCharLimit,
  variantConfigFromBase,
  variantsToGenerate,
} from "./super-text-variants";

const base: SuperTextConfig = {
  version: 1,
  segments: [{ text: "Wait" }, { text: "for", color: "#EF4444" }, { text: "it 😍" }],
  stripColor: "#FFFFFF",
  textColor: "#111111",
  xPct: 50,
  yPct: 72,
  fontSizePct: 4.2,
  font: "sans",
};

describe("variantConfigFromBase", () => {
  it("keeps every styling field and swaps only the words", () => {
    const v = variantConfigFromBase(base, "You won't believe this")!;
    expect(v).not.toBeNull();
    expect(v.segments.map((s) => s.text)).toEqual(["You", "won't", "believe", "this"]);
    expect(v).toMatchObject({
      stripColor: "#FFFFFF",
      textColor: "#111111",
      xPct: 50,
      yPct: 72,
      fontSizePct: 4.2,
      font: "sans",
    });
  });

  it("carries per-word highlight colours by POSITION", () => {
    const v = variantConfigFromBase(base, "Keep watching now")!;
    expect(v.segments[0]).toEqual({ text: "Keep" });
    expect(v.segments[1]).toEqual({ text: "watching", color: "#EF4444" });
    expect(v.segments[2]).toEqual({ text: "now" });
  });

  it("rejects text the schema cannot hold", () => {
    expect(variantConfigFromBase(base, "")).toBeNull();
    expect(variantConfigFromBase(base, "x".repeat(61))).toBeNull(); // one word over 60
    expect(variantConfigFromBase(base, Array(40).fill("word").join(" "))).toBeNull(); // > 150 chars
  });
});

describe("parseVariantArray", () => {
  it("tolerates fences and prose, strips quotes, collapses whitespace", () => {
    const raw = 'Sure!\n```json\n[{"index":0,"text":"  \\"Hold  on\\n tight\\" "},{"index":1,"text":"Nope"}]\n```';
    expect(parseVariantArray(raw)).toEqual([
      { index: 0, text: "Hold on tight" },
      { index: 1, text: "Nope" },
    ]);
  });

  it("drops malformed items and throws with no array at all", () => {
    expect(parseVariantArray('[{"index":"a","text":"x"},{"text":5},{"index":2,"text":"ok"}]')).toEqual([
      { index: 2, text: "ok" },
    ]);
    expect(() => parseVariantArray("no json here")).toThrow();
  });
});

describe("sanitizeVariantTexts", () => {
  it("removes copies of the base, duplicates, over-long and unrepresentable lines", () => {
    const out = sanitizeVariantTexts({
      baseText: baseTextOf(base),
      baseCfg: base,
      charLimit: 40,
      candidates: [
        "wait for it 😍", // base, different case
        "Hold on tight",
        "HOLD ON TIGHT!", // duplicate of the previous
        "This line is far too long for a forty character strip, honestly",
        "Just wait",
        "",
      ],
    });
    expect(out).toEqual(["Hold on tight", "Just wait"]);
  });
});

describe("limits + assignment", () => {
  it("variantCharLimit tracks the base length within [40, 150]", () => {
    expect(variantCharLimit("hi")).toBe(40);
    expect(variantCharLimit("x".repeat(50))).toBe(80);
    expect(variantCharLimit("x".repeat(150))).toBe(150);
  });

  it("assignVariantIndexes is round-robin starting at the base (0)", () => {
    expect(assignVariantIndexes(5, 2)).toEqual([0, 1, 2, 0, 1]);
    expect(assignVariantIndexes(3, 0)).toEqual([0, 0, 0]);
  });

  it("variantsToGenerate never exceeds targets-1 or cap-1", () => {
    expect(variantsToGenerate(1, 40)).toBe(0);
    expect(variantsToGenerate(5, 40)).toBe(4);
    expect(variantsToGenerate(240, 40)).toBe(39);
  });

  it("maxSuperTextVariants reads the env with a sane default", () => {
    expect(maxSuperTextVariants({} as NodeJS.ProcessEnv)).toBe(40);
    expect(maxSuperTextVariants({ SUPER_TEXT_MAX_VARIANTS: "" } as NodeJS.ProcessEnv)).toBe(40);
    expect(maxSuperTextVariants({ SUPER_TEXT_MAX_VARIANTS: "0" } as NodeJS.ProcessEnv)).toBe(40);
    expect(maxSuperTextVariants({ SUPER_TEXT_MAX_VARIANTS: "12" } as NodeJS.ProcessEnv)).toBe(12);
  });

  it("normalizeVariantText ignores case, punctuation and emoji", () => {
    expect(normalizeVariantText("Wait for it 😍!!")).toBe(normalizeVariantText("wait FOR it"));
  });
});

describe("buildSuperTextVariantPrompt", () => {
  it("names the base line, every channel, the limit, and the JSON shape", () => {
    const p = buildSuperTextVariantPrompt({
      baseText: "Wait for it 😍",
      postContent: "Our new reel",
      charLimit: 40,
      channels: [
        { index: 0, platform: "INSTAGRAM", channelName: "Memes", username: "memes" },
        { index: 1, platform: "FACEBOOK", channelName: "Page", username: null },
      ],
    });
    expect(p).toContain("Wait for it 😍");
    expect(p).toContain('0. platform=INSTAGRAM, channel="Memes" (@memes)');
    expect(p).toContain('1. platform=FACEBOOK, channel="Page"');
    expect(p).toContain("at most 40 characters");
    expect(p).toContain('[{"index": 0, "text": "..."}');
    expect(p).toContain("Emoji are welcome");
    expect(
      buildSuperTextVariantPrompt({ baseText: "plain", postContent: "", charLimit: 40, channels: [] })
    ).toContain("Do not add emoji");
  });
});
