import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseCardHint } from "../tools/classify-card";

describe("parseCardHint — structured vision parsing + sanitization", () => {
  it("parses a well-formed JSON response", () => {
    const raw = JSON.stringify({
      preset: "news_inset",
      blocks: { logo: true, circularInset: 1, labelChip: 1, captionCount: 2 },
      theme: "dark",
      accentColor: "#1e90ff",
      confidence: 0.82,
    });
    const hint = parseCardHint(raw);
    expect(hint).not.toBeNull();
    expect(hint!.preset).toBe("news_inset");
    expect(hint!.blocks.circularInset).toBe(1);
    expect(hint!.theme).toBe("dark");
    expect(hint!.accentColor).toBe("#1e90ff");
    expect(hint!.confidence).toBeCloseTo(0.82);
  });

  it("strips ```json fences before parsing", () => {
    const raw = '```json\n{"preset":"tweet_card","blocks":{"tweetHeader":true},"theme":"light","accentColor":"#000000","confidence":0.9}\n```';
    expect(parseCardHint(raw)!.preset).toBe("tweet_card");
  });

  it("rejects an unknown preset → null (falls back to news_caption at call site)", () => {
    const raw = JSON.stringify({ preset: "totally_made_up", theme: "light", accentColor: "#fff", confidence: 0.9, blocks: {} });
    expect(parseCardHint(raw)).toBeNull();
  });

  it("sanitizes a malicious accentColor to the default", () => {
    const raw = JSON.stringify({ preset: "news_caption", blocks: {}, theme: "light", accentColor: '#fff" onload=alert(1)', confidence: 0.7 });
    expect(parseCardHint(raw)!.accentColor).toBe("#e11d48");
  });

  it("clamps an out-of-range confidence and coerces a bad theme", () => {
    const raw = JSON.stringify({ preset: "news_caption", blocks: {}, theme: "neon", accentColor: "#abc", confidence: 5 });
    const hint = parseCardHint(raw)!;
    expect(hint.confidence).toBe(1);
    expect(hint.theme).toBe("light");
  });

  it("returns null on non-JSON garbage", () => {
    expect(parseCardHint("the image shows a person")).toBeNull();
  });
});
