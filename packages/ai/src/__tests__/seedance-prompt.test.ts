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
    expect(prompt).toContain("X"); // title interpolated
  });
});
