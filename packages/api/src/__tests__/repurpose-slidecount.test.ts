import { describe, it, expect } from "vitest";
import { enforceSlideCount, contentSlidesForTotal } from "../routers/repurpose.router";

type Slide = { title: string; body: string };

describe("contentSlidesForTotal", () => {
  it("maps total=3 → 1 content slide (cover + 1 + cta = 3 total)", () => {
    expect(contentSlidesForTotal(3)).toBe(1);
  });

  it("maps total=5 → 3 content slides (cover + 3 + cta = 5 total)", () => {
    expect(contentSlidesForTotal(5)).toBe(3);
  });

  it("maps total=10 → 8 content slides (cover + 8 + cta = 10 total)", () => {
    expect(contentSlidesForTotal(10)).toBe(8);
  });

  it("clamps to min 1 when total=2 (would be 0)", () => {
    expect(contentSlidesForTotal(2)).toBe(1);
  });

  it("clamps to min 1 when total=1 (would be negative)", () => {
    expect(contentSlidesForTotal(1)).toBe(1);
  });
});

function slides(n: number, prefix = "real"): Slide[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `${prefix} ${i + 1}`,
    body: `${prefix} body ${i + 1}`,
  }));
}

describe("enforceSlideCount", () => {
  it("slices when longer than target", () => {
    const out = enforceSlideCount(slides(7), 5, []);
    expect(out).toHaveLength(5);
    // First 5 originals preserved, in order.
    expect(out[0]!.title).toBe("real 1");
    expect(out[4]!.title).toBe("real 5");
  });

  it("appends from fallback, then pads with generic fillers when shorter", () => {
    const out = enforceSlideCount(slides(2), 5, slides(2, "fb"));
    expect(out).toHaveLength(5);
    // 2 real + 2 fallback + 1 generic filler.
    expect(out[0]!.title).toBe("real 1");
    expect(out[1]!.title).toBe("real 2");
    expect(out[2]!.title).toBe("fb 1");
    expect(out[3]!.title).toBe("fb 2");
    expect(out[4]!.title).toBe("Key point 5");
    expect(out[4]!.body).toBe("");
  });

  it("pads entirely with generic fillers when both inputs empty", () => {
    const out = enforceSlideCount([], 4, []);
    expect(out).toHaveLength(4);
    expect(out[0]!.title).toBe("Key point 1");
    expect(out[1]!.title).toBe("Key point 2");
    expect(out[2]!.title).toBe("Key point 3");
    expect(out[3]!.title).toBe("Key point 4");
    expect(out.every((s) => s.body === "")).toBe(true);
  });

  it("returns unchanged when length already equals target", () => {
    const input = slides(3);
    const out = enforceSlideCount(input, 3, slides(2, "fb"));
    expect(out).toHaveLength(3);
    expect(out[0]!.title).toBe("real 1");
    expect(out[1]!.title).toBe("real 2");
    expect(out[2]!.title).toBe("real 3");
  });
});
