import { describe, expect, it } from "vitest";
import { capBody } from "../routers/repurpose.router";

describe("capBody", () => {
  it("leaves text within maxChars unchanged", () => {
    expect(capBody("Hello world", 50)).toBe("Hello world");
  });

  it("cuts on a whole-word boundary and appends '…'", () => {
    const text = "The quick brown fox jumps over the lazy dog near the river";
    const out = capBody(text, 30);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(31); // ≤30 chars + "…"
    // No partial words — the char before "…" should be a complete word end
    const withoutEllipsis = out.slice(0, -1);
    expect(withoutEllipsis).not.toMatch(/\s$/);
    expect(withoutEllipsis.split(" ").every((w) => text.includes(w))).toBe(true);
  });

  it("does not append '…' when text fits exactly", () => {
    const text = "Short text";
    expect(capBody(text, 10)).toBe("Short text");
  });

  it("trims surrounding whitespace", () => {
    expect(capBody("  hello world  ", 50)).toBe("hello world");
  });

  it("strips trailing punctuation before the ellipsis", () => {
    // A word boundary cut that lands on a comma/semicolon should strip it
    const text = "Breaking news, important update, more details available soon";
    const out = capBody(text, 25);
    expect(out).not.toMatch(/[,;]\s*…$/);
    expect(out.endsWith("…")).toBe(true);
  });
});
