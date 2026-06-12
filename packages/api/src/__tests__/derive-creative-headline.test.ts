/**
 * Regression guard for F4: carousel cover headline now uses the same 3-step
 * derivation pipeline as the static branch via deriveCreativeHeadline().
 *
 * Steps under test:
 *  1. Generic-title → AI SUBJECT swap
 *  2. Social-post caption synthesis
 *  3. Notes-aware rewrite (wording instructions only)
 */
import { describe, it, expect, vi } from "vitest";
import { deriveCreativeHeadline } from "../routers/repurpose.router";

const noop = async (_: string) => "";

describe("deriveCreativeHeadline — generic-title swap (step 1)", () => {
  it("prefers SUBJECT from contentBrief when title looks generic", async () => {
    const result = await deriveCreativeHeadline({
      extracted: { title: "Latest News Today | The Indian Express", description: "", body: "", type: "article" },
      contentBrief: "SUBJECT: India GDP Growth\nCATEGORY: economy",
      contentSummary: "India GDP grew 8% in Q4.",
      creativeNotes: "",
      generateFn: noop,
    });
    expect(result).toContain("India GDP Growth");
  });

  it("keeps a specific article title as-is when not generic", async () => {
    const result = await deriveCreativeHeadline({
      extracted: { title: "FIFA World Cup 2026 streaming in India", description: "", body: "", type: "article" },
      contentBrief: "SUBJECT: FIFA World Cup 2026\nCATEGORY: sports",
      contentSummary: "DD Sports to telecast matches.",
      creativeNotes: "",
      generateFn: noop,
    });
    expect(result.toLowerCase()).toContain("fifa");
  });
});

describe("deriveCreativeHeadline — social synthesis (step 2)", () => {
  it("calls generateFn for social-type content to synthesize a clean headline", async () => {
    const generateFn = vi.fn().mockResolvedValue("Big News for Football Fans");
    const result = await deriveCreativeHeadline({
      extracted: { title: "🎉 Watch FIFA 2026 FREE on DD Sports!! #FIFA2026 🏆⚽🎊", description: "", body: "Some caption text", type: "social" },
      contentBrief: "SUBJECT: FIFA World Cup 2026",
      contentSummary: "Some caption text",
      creativeNotes: "",
      generateFn,
    });
    expect(generateFn).toHaveBeenCalled();
    expect(result).toBe("Big News for Football Fans");
  });

  it("falls back to the step-1 headline when synthesis fails", async () => {
    const generateFn = vi.fn().mockRejectedValue(new Error("AI error"));
    const result = await deriveCreativeHeadline({
      extracted: { title: "Social caption", description: "", body: "body", type: "social" },
      contentBrief: "",
      contentSummary: "body",
      creativeNotes: "",
      generateFn,
    });
    expect(result).toBe("Social caption");
  });
});

describe("deriveCreativeHeadline — notes-aware rewrite (step 3)", () => {
  it("applies wording instructions from creativeNotes", async () => {
    const generateFn = vi.fn().mockResolvedValue("Doordarshan to stream FIFA 2026 free");
    const result = await deriveCreativeHeadline({
      extracted: { title: "FIFA World Cup 2026 streaming in India", description: "", body: "", type: "article" },
      contentBrief: "SUBJECT: FIFA\nCATEGORY: sports",
      contentSummary: "DD Sports context",
      creativeNotes: "Mention Doordarshan in the headline",
      generateFn,
    });
    expect(generateFn).toHaveBeenCalledTimes(1);
    expect(result).toContain("Doordarshan");
  });

  it("does NOT call generateFn for the rewrite when creativeNotes is empty", async () => {
    const generateFn = vi.fn().mockResolvedValue("anything");
    await deriveCreativeHeadline({
      extracted: { title: "Specific Article Headline", description: "", body: "", type: "article" },
      contentBrief: "",
      contentSummary: "",
      creativeNotes: "",
      generateFn,
    });
    expect(generateFn).not.toHaveBeenCalled();
  });

  it("caps the output to 16 words regardless of what generateFn returns", async () => {
    const longHeadline = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
    const generateFn = vi.fn().mockResolvedValue(longHeadline);
    const result = await deriveCreativeHeadline({
      extracted: { title: "Some Title", description: "", body: "", type: "article" },
      contentBrief: "",
      contentSummary: "",
      creativeNotes: "some notes",
      generateFn,
    });
    expect(result.split(" ").length).toBeLessThanOrEqual(16);
  });
});
