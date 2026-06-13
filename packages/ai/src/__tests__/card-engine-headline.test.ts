import { describe, it, expect } from "vitest";
import { capHeadline, capBody, jaccardSimilarity, dedupeHook } from "../tools/card-engine";

describe("capHeadline", () => {
  it("returns short headlines unchanged", () => {
    expect(capHeadline("Big news today")).toBe("Big news today");
  });
  it("never cuts mid-word; appends … when over budget", () => {
    const long = "This is an extremely long headline that runs well past the sixteen word and ninety character ceiling for sure indeed truly";
    const out = capHeadline(long);
    expect(out.length).toBeLessThanOrEqual(91);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\s\S{1,2}…$/); // no dangling fragment
  });
  it("prefers a full-sentence boundary when one is past the 60% floor", () => {
    // First sentence ends at "statewide." which lands past 60% of the 16-word/
    // 90-char window, so the sentence-boundary branch is taken (ends on ".").
    const out = capHeadline(
      "The new policy takes effect next Monday across all twelve districts statewide. More details to follow soon",
    );
    expect(out.endsWith(".")).toBe(true);
    expect(out).toContain("The new policy takes effect");
  });
  it("collapses internal whitespace", () => {
    expect(capHeadline("a   b   c")).toBe("a b c");
  });
});

describe("capBody", () => {
  it("returns short body unchanged", () => {
    expect(capBody("short body", 120)).toBe("short body");
  });
  it("cuts on a whole-word boundary and appends …", () => {
    const out = capBody("alpha beta gamma delta epsilon", 18);
    expect(out).toBe("alpha beta gamma…"); // cut at a word boundary, no "d" fragment
    expect(out).not.toContain("epsilon");
  });
});

describe("jaccardSimilarity", () => {
  it("is 1 for identical strings and 0 for disjoint", () => {
    expect(jaccardSimilarity("a b c", "a b c")).toBe(1);
    expect(jaccardSimilarity("a b c", "x y z")).toBe(0);
  });
  it("is case/punctuation insensitive", () => {
    expect(jaccardSimilarity("Big News!", "big news")).toBeGreaterThan(0.9);
  });
});

describe("dedupeHook", () => {
  it("drops a hook that is a near-duplicate of the headline", () => {
    expect(dedupeHook("TMC leader arrested near border", "TMC leader arrested near the border")).toBe("");
  });
  it("keeps a hook that adds a different angle", () => {
    expect(dedupeHook("How did this even happen?!", "TMC leader arrested near border")).toBe("How did this even happen?!");
  });
  it("drops an empty/whitespace hook", () => {
    expect(dedupeHook("   ", "Anything")).toBe("");
  });
});
