import { describe, it, expect } from "vitest";
import { buildStaticCreative, themeTokens } from "../tools/creative-templates";

describe("themeTokens", () => {
  it("light theme uses dark text + light background", () => {
    const t = themeTokens("light", "#0052cc");
    expect(t.textColor).toBe("#0f1419");
    expect(t.textColor).toMatch(/^#0/);
    expect(t.bgFallback).toMatch(/#f/i);
  });

  it("dark theme uses white text + dark background", () => {
    const t = themeTokens("dark", "#0052cc");
    expect(t.textColor).toBe("#ffffff");
    expect(t.bgFallback).toContain("1a");
  });

  it("gradient theme embeds the (safe) accent in the background", () => {
    const t = themeTokens("gradient", "#0052cc");
    expect(t.bgFallback).toContain("#0052cc");
    expect(t.textColor).toBe("#ffffff");
  });

  it("sanitizes a malicious accent (no javascript: leaks through)", () => {
    const t = themeTokens("light", "javascript:alert(1)");
    expect(t.bgFallback).not.toContain("javascript:");
    expect(t.scrim).not.toContain("javascript:");
    expect(t.textColor).not.toContain("javascript:");
    expect(t.subTextColor).not.toContain("javascript:");
  });
});

describe("theme-aware static creatives", () => {
  it("premium_editorial WITH a photo + light theme uses dark text + the photo bg", () => {
    const html = buildStaticCreative({
      style: "premium_editorial",
      theme: "light",
      headline: "Hello",
      channelName: "X",
      handle: "x",
      logoPosition: "top-right",
      bgImageUrl: "https://cdn.example.com/photo.jpg",
    });
    // With a photo the requested light theme is honored: dark text + photo bg.
    expect(html).toContain("#0f1419");
    expect(html).toContain("https://cdn.example.com/photo.jpg");
    expect(html).not.toContain("background:#000");
    expect(html).not.toContain("#0d0d12");
  });

  it("premium_editorial light + NO photo forces a branded gradient (white text, never blank-white)", () => {
    // 2026-06-11: a photoless creative must never sit on a flat near-white fill
    // (read as "blank"). buildPremiumEditorial forces the gradient theme — white
    // headline on a rich brand gradient — when there's no bgImageUrl.
    const html = buildStaticCreative({
      style: "premium_editorial",
      theme: "light",
      headline: "Hello",
      channelName: "X",
      handle: "x",
      brandColor: "#e11d48",
      logoPosition: "top-right",
    });
    expect(html).toContain("linear-gradient(");
    expect(html).toContain("#ffffff"); // white headline text
    expect(html).not.toContain("background:#f7f7f8"); // not the flat near-white blank
    expect(html).not.toContain("#0d0d12");
  });

  it("bold_typographic light varies by headline and drops #0d0d12", () => {
    const common = {
      style: "bold_typographic" as const,
      theme: "light" as const,
      channelName: "X",
      logoPosition: "top-left" as const,
    };
    const a = buildStaticCreative({ ...common, headline: "A" });
    const b = buildStaticCreative({ ...common, headline: "B" });
    expect(a).not.toBe(b);
    // Only the headline differs — replacing it in `a` should yield `b`.
    expect(a.replace(/>A</g, ">B<")).toBe(b);
    expect(a).not.toContain("#0d0d12");
    expect(b).not.toContain("#0d0d12");
  });
});
