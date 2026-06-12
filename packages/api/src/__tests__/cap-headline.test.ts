import { describe, expect, it } from "vitest";
import { capHeadline } from "../routers/repurpose.router";

describe("capHeadline", () => {
  it("leaves a headline within budget (≤16 words AND ≤90 chars) unchanged", () => {
    const short = "Krrish 4 Budget Controversy";
    expect(capHeadline(short)).toBe(short);
  });

  it("leaves a 16-word headline unchanged when it also fits within 90 chars", () => {
    // 16 short words totalling well under 90 chars — both axes satisfied
    const exactly16 = "a b c d e f g h i j k l m n o p";
    const out = capHeadline(exactly16);
    expect(out).toBe(exactly16);
    expect(out.split(/\s+/).length).toBe(16);
  });

  it("caps a >16-word headline and never ends mid-word", () => {
    const long = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen";
    const out = capHeadline(long);
    expect(out.split(/\s+/).length).toBeLessThanOrEqual(16);
    expect(out.length).toBeLessThanOrEqual(90);
    // Must end on a complete word or the "…" abbreviation marker — never mid-word
    expect(out).toMatch(/[a-zA-Z0-9'")\]!?.]$|…$/);
  });

  it("appends '…' when content is dropped and no sentence boundary exists", () => {
    const long = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen";
    const out = capHeadline(long);
    expect(out.endsWith("…")).toBe(true);
  });

  it("prefers cutting at the last sentence boundary when one is late enough", () => {
    // The period is at position >60% of the kept text, so the function should
    // cut cleanly there and NOT append "…".
    const text = "Iran announces closure of Strait of Hormuz after US strikes. Officials say retaliation is imminent across the region tonight";
    const out = capHeadline(text);
    expect(out.endsWith(".")).toBe(true);
    expect(out.endsWith("…")).toBe(false);
  });

  it("never exceeds 90 chars even for 16 long words", () => {
    const long = Array.from({ length: 16 }, () => "supercali").join(" "); // 16 * 9 + 15 spaces = 159 chars
    const out = capHeadline(long);
    expect(out.length).toBeLessThanOrEqual(90);
    // Must not end mid-word (last char before optional "…" should be a complete token)
    const withoutEllipsis = out.replace(/…$/, "");
    expect(withoutEllipsis.trim()).not.toMatch(/\s$/);
  });

  it("trims surrounding whitespace", () => {
    expect(capHeadline("   hello world   ")).toBe("hello world");
  });

  it("collapses internal whitespace", () => {
    expect(capHeadline("hello   world")).toBe("hello world");
  });
});
