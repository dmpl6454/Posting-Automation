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
  it("premium_editorial light uses dark text and no hardcoded dark bg", () => {
    const html = buildStaticCreative({
      style: "premium_editorial",
      theme: "light",
      headline: "Hello",
      channelName: "X",
      handle: "x",
      logoPosition: "top-right",
    });
    expect(html).toContain("#0f1419");
    expect(html).not.toContain("background:#000");
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
