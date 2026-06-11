import { describe, expect, it } from "vitest";
import { appendImageContext, mergeStyleContext } from "../routers/repurpose.router";

describe("appendImageContext", () => {
  it("appends non-empty image context as a 'Style notes:' clause", () => {
    const out = appendImageContext("BASE", "make it neon and moody");
    expect(out).toContain("BASE");
    expect(out).toContain("Style notes: make it neon and moody");
  });

  it("returns the base prompt unchanged when context is undefined", () => {
    expect(appendImageContext("BASE", undefined)).toBe("BASE");
  });

  it("returns the base prompt unchanged when context is empty / whitespace", () => {
    expect(appendImageContext("BASE", "")).toBe("BASE");
    expect(appendImageContext("BASE", "   ")).toBe("BASE");
  });

  it("caps the appended notes at 300 characters", () => {
    const out = appendImageContext("BASE", "x".repeat(400));
    // The appended notes (everything after "Style notes: ") must be <= 300 chars.
    const idx = out.indexOf("Style notes: ");
    expect(idx).toBeGreaterThanOrEqual(0);
    const notes = out.slice(idx + "Style notes: ".length);
    expect(notes.length).toBeLessThanOrEqual(300);
  });
});

describe("mergeStyleContext", () => {
  it("joins imageContext and styleDescriptor with '. '", () => {
    expect(mergeStyleContext("neon and moody", "warm cinematic palette")).toBe(
      "neon and moody. warm cinematic palette",
    );
  });

  it("returns just the imageContext when no styleDescriptor", () => {
    expect(mergeStyleContext("neon and moody", undefined)).toBe("neon and moody");
  });

  it("returns just the styleDescriptor when no imageContext", () => {
    expect(mergeStyleContext(undefined, "warm cinematic palette")).toBe(
      "warm cinematic palette",
    );
  });

  it("returns undefined when both are empty / undefined", () => {
    expect(mergeStyleContext(undefined, undefined)).toBeUndefined();
    expect(mergeStyleContext("", "")).toBeUndefined();
  });

  it("output flows cleanly through appendImageContext", () => {
    const merged = mergeStyleContext("neon", "warm light");
    const out = appendImageContext("BASE", merged);
    expect(out).toContain("Style notes: neon. warm light");
  });
});
