import { describe, it, expect } from "vitest";
import { buildSeedancePrompt } from "../providers/seedance.provider";

describe("buildSeedancePrompt — generic people allowed, specific real individuals forbidden", () => {
  const prompt = buildSeedancePrompt({
    title: "X",
    keyPoints: ["a", "b"],
  });

  it("no longer contains the old blanket 'Do NOT show real people' ban", () => {
    expect(prompt).not.toContain("Do NOT show real people");
  });

  it("forbids depicting any specific, real, named individual", () => {
    expect(prompt).toMatch(/specific, real, named/i);
  });

  it("allows generic, anonymous people and crowds", () => {
    expect(prompt.toLowerCase()).toContain("generic");
  });

  it("keeps the core scene structure", () => {
    expect(prompt).toContain("9:16");
    expect(prompt).toContain("X"); // title used as subject context
  });
});

describe("buildSeedancePrompt — visuals only, no on-screen text", () => {
  const prompt = buildSeedancePrompt({
    title: "Breaking News Headline",
    keyPoints: ["first key point", "second key point", "third key point"],
    brandName: "MyBrand",
  });

  it("does NOT command bold white on-screen text", () => {
    expect(prompt).not.toContain("Bold white text");
  });

  it("does NOT include the SUPER BOLD text directive", () => {
    expect(prompt).not.toContain("SUPER BOLD");
  });

  it("does NOT include a 'Text:' on-screen-text directive", () => {
    expect(prompt).not.toContain("Text:");
  });

  it("contains an explicit no-on-screen-text negative clause", () => {
    expect(prompt).toContain("Do NOT render any on-screen text");
  });

  it("retains the people policy (specific real named figures forbidden)", () => {
    expect(prompt).toMatch(/specific, real, named/i);
  });

  it("retains 9:16 vertical framing", () => {
    expect(prompt).toContain("9:16");
  });

  it("uses the title as subject context", () => {
    expect(prompt).toContain("Breaking News Headline");
  });

  it("depicts each key point visually rather than as text", () => {
    for (const point of ["first key point", "second key point", "third key point"]) {
      expect(prompt).toContain(`visually depicting: ${point}`);
    }
  });
});
