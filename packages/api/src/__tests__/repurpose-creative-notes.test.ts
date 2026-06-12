/**
 * Regression guard for the creative-notes → hook/headline wiring (round 5).
 *
 * Bug: the UI's "Aesthetic / style notes" (input.imageContext) only reached the
 * AI BACKGROUND prompt (appendImageContext), so wording instructions like
 * "mention Doordarshan in the hook" were silently ignored — the hook-line and
 * headline AI calls never saw them. The prompts are now built by exported pure
 * helpers that fold the notes in as wording instructions (visual instructions
 * are explicitly told to be ignored, since colors/layout are template-owned).
 */
import { describe, it, expect } from "vitest";
import { buildHookLinePrompt, buildHeadlineRewritePrompt } from "../routers/repurpose.router";

describe("buildHookLinePrompt", () => {
  it("contains the headline and the **emphasis** instruction", () => {
    const p = buildHookLinePrompt("FIFA World Cup 2026 streaming in India");
    expect(p).toContain("FIFA World Cup 2026 streaming in India");
    expect(p).toContain("**double asterisks**");
  });

  it("omits the user-instructions clause when no notes are given", () => {
    expect(buildHookLinePrompt("Some headline")).not.toContain("User instructions");
    expect(buildHookLinePrompt("Some headline", "   ")).not.toContain("User instructions");
  });

  it("folds creative notes in as wording instructions", () => {
    const p = buildHookLinePrompt("FIFA headline", "Make sure to mention Doordarshan in red (in the hook)");
    expect(p).toContain("Make sure to mention Doordarshan in red (in the hook)");
    expect(p).toContain("User instructions");
    // Visual directives are explicitly out of scope for the text call.
    expect(p).toMatch(/ignore parts about colors, layout, or imagery/i);
  });
});

describe("buildHeadlineRewritePrompt", () => {
  it("contains headline, article context, and the user's notes", () => {
    const p = buildHeadlineRewritePrompt(
      "Free FIFA World Cup 2026 streaming in India",
      "DD Sports will telecast the opening match free in India...",
      "mention Doordarshan in the hook",
    );
    expect(p).toContain("Free FIFA World Cup 2026 streaming in India");
    expect(p).toContain("DD Sports will telecast");
    expect(p).toContain("mention Doordarshan in the hook");
  });

  it("instructs the model to leave the headline unchanged when no wording instruction applies", () => {
    const p = buildHeadlineRewritePrompt("h", "ctx", "make it moody and neon");
    expect(p).toMatch(/return the current headline UNCHANGED/i);
    // And to ignore the visual-only parts entirely.
    expect(p).toMatch(/Ignore instructions about colors, fonts, layout, or imagery/i);
  });

  it("caps the output contract at 14 words (matches capHeadline budget with headroom)", () => {
    expect(buildHeadlineRewritePrompt("h", "ctx", "notes")).toContain("max 14 words");
  });
});
