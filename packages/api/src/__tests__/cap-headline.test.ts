import { describe, expect, it } from "vitest";
import { capHeadline } from "../routers/repurpose.router";

describe("capHeadline", () => {
  it("caps a >12-word headline to exactly 12 words", () => {
    const out = capHeadline("one two three four five six seven eight nine ten eleven twelve thirteen fourteen");
    expect(out.split(/\s+/).length).toBe(12);
    expect(out).toBe("one two three four five six seven eight nine ten eleven twelve");
  });

  it("leaves a short headline unchanged", () => {
    expect(capHeadline("Krrish 4 Budget Controversy")).toBe("Krrish 4 Budget Controversy");
  });

  it("caps to <=80 chars and trims any dangling partial word at the boundary", () => {
    // 12 long words → the joined slice exceeds 80 chars, so the char-cap kicks in.
    const long = Array.from({ length: 12 }, () => "supercalifragilistic").join(" ");
    const out = capHeadline(long);
    expect(out.length).toBeLessThanOrEqual(80);
    // The 80-char slice's trailing partial word is dropped (no mid-word cut).
    expect(out.endsWith("supercalifragilistic")).toBe(true);
  });

  it("never exceeds 12 words AND 80 chars together", () => {
    const out = capHeadline(
      "Breaking news report on the largest economic summit ever held with leaders from every continent attending",
    );
    expect(out.split(/\s+/).length).toBeLessThanOrEqual(12);
    expect(out.length).toBeLessThanOrEqual(80);
  });

  it("trims surrounding whitespace", () => {
    expect(capHeadline("   hello world   ")).toBe("hello world");
  });
});
