import { describe, expect, it } from "vitest";
import { compactSlides } from "../routers/repurpose.router";

describe("compactSlides", () => {
  it("drops undefined holes from a sparse slide array without throwing", () => {
    const x = { imageBase64: "x", mimeType: "image/png" };
    const z = { imageBase64: "z", mimeType: "image/jpeg" };
    expect(compactSlides([x, undefined, z])).toEqual([x, z]);
  });

  it("drops nulls too", () => {
    const a = { imageBase64: "a", mimeType: "image/png" };
    expect(compactSlides([null, a, undefined])).toEqual([a]);
  });

  it("returns an empty array when every slide failed", () => {
    expect(compactSlides([undefined, undefined])).toEqual([]);
  });

  it("returns all slides when none failed", () => {
    const a = { imageBase64: "a", mimeType: "image/png" };
    const b = { imageBase64: "b", mimeType: "image/png" };
    expect(compactSlides([a, b])).toEqual([a, b]);
  });

  it("mapping the result never crashes on a hole (regression for the reel TypeError)", () => {
    const slides: ({ imageBase64: string; mimeType: string } | undefined)[] = [
      { imageBase64: "x", mimeType: "image/png" },
      undefined,
    ];
    expect(() => compactSlides(slides).map((s) => s.imageBase64)).not.toThrow();
    expect(compactSlides(slides).map((s) => s.imageBase64)).toEqual(["x"]);
  });
});
