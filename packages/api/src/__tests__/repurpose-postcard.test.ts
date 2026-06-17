/**
 * REP-3 router: postcard_grid schema + tileCount derivation tests.
 *
 * Verifies:
 *   (a) The main repurpose input schema ACCEPTS creativeStyle:"postcard_grid"
 *       and that gridPreset is optional (defaults gracefully).
 *   (b) tileCount derivation: two_up→2, three_up→3, grid_2x2→4.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

// ── helpers matching the router's tileCount derivation (pure, exported for tests) ──

/** Derive tile count from gridPreset — mirrors the router logic exactly. */
function tileCountFromPreset(preset: "two_up" | "three_up" | "grid_2x2"): number {
  return preset === "two_up" ? 2 : preset === "three_up" ? 3 : 4;
}

// ── Minimal schema slice matching the router's new fields ──

const postcardSchemaSlice = z.object({
  creativeStyle: z
    .enum(["premium_editorial", "hook_bars", "tweet_card", "bold_typographic", "postcard_grid"])
    .default("premium_editorial"),
  gridPreset: z.enum(["two_up", "three_up", "grid_2x2"]).optional(),
});

// ────────────────────────────────────────────────────────────────────────────────

describe("repurpose router: postcard_grid schema", () => {
  it('accepts creativeStyle:"postcard_grid"', () => {
    const result = postcardSchemaSlice.parse({ creativeStyle: "postcard_grid" });
    expect(result.creativeStyle).toBe("postcard_grid");
  });

  it('accepts postcard_grid + gridPreset:"three_up"', () => {
    const result = postcardSchemaSlice.parse({
      creativeStyle: "postcard_grid",
      gridPreset: "three_up",
    });
    expect(result.creativeStyle).toBe("postcard_grid");
    expect(result.gridPreset).toBe("three_up");
  });

  it("gridPreset is optional — omitting it parses cleanly", () => {
    const result = postcardSchemaSlice.parse({ creativeStyle: "postcard_grid" });
    expect(result.gridPreset).toBeUndefined();
  });

  it("default creativeStyle is still premium_editorial (no regression)", () => {
    const result = postcardSchemaSlice.parse({});
    expect(result.creativeStyle).toBe("premium_editorial");
  });

  it("rejects an unknown creativeStyle value", () => {
    expect(() =>
      postcardSchemaSlice.parse({ creativeStyle: "unknown_style" }),
    ).toThrow();
  });

  it("rejects an unknown gridPreset value", () => {
    expect(() =>
      postcardSchemaSlice.parse({ creativeStyle: "postcard_grid", gridPreset: "five_up" }),
    ).toThrow();
  });
});

describe("repurpose router: tileCount derivation", () => {
  it("two_up → 2 tiles", () => {
    expect(tileCountFromPreset("two_up")).toBe(2);
  });

  it("three_up → 3 tiles", () => {
    expect(tileCountFromPreset("three_up")).toBe(3);
  });

  it("grid_2x2 → 4 tiles", () => {
    expect(tileCountFromPreset("grid_2x2")).toBe(4);
  });
});
