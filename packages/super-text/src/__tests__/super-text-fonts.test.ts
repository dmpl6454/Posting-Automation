/**
 * Font picker for the super-text strip.
 *
 * The two cases that matter most:
 *  1. A config with NO `font` key must render byte-identically to the pre-picker
 *     output — that is what keeps every existing post and draft safe, and what
 *     keeps their cached burns valid (the worker keys S3 objects on
 *     sha1(JSON.stringify(config))).
 *  2. The font value is NEVER interpolated into the style attribute. It selects a
 *     spec from a closed registry by key, the same discipline as safeHexColor.
 */
import { describe, it, expect } from "vitest";
import {
  SUPER_TEXT_FONTS,
  SUPER_TEXT_FONT_KEYS,
  DEFAULT_SUPER_TEXT_FONT,
  resolveSuperTextFont,
  SUPER_TEXT_FONT_STACK,
  STRIP_FONT_WEIGHT,
} from "../constants";
import { superTextConfigSchema } from "../schema";

/** A valid config with NO font key — i.e. every config written before this feature. */
const baseConfig = {
  version: 1 as const,
  segments: [{ text: "Ranveer" }, { text: "returns", color: "#EF4444" }],
  stripColor: "#FFFFFF",
  textColor: "#111111",
  xPct: 50,
  yPct: 72,
  fontSizePct: 4.2,
};

describe("super text font registry", () => {
  it("exposes exactly the two supported keys", () => {
    expect(SUPER_TEXT_FONT_KEYS).toEqual(["classic", "sans"]);
  });

  it("defaults to classic", () => {
    expect(DEFAULT_SUPER_TEXT_FONT).toBe("classic");
  });

  it("classic reproduces today's stack, weight and zero tracking exactly", () => {
    const classic = SUPER_TEXT_FONTS.classic;
    expect(classic.stack).toBe(SUPER_TEXT_FONT_STACK);
    expect(classic.weight).toBe(STRIP_FONT_WEIGHT);
    expect(classic.letterSpacingEm).toBe(0);
    // No embedded payload => no @font-face => nothing new can affect the render.
    expect(classic.embedded).toBeNull();
  });

  it("sans keeps the classic stack as its fallback chain", () => {
    // A missing glyph (e.g. Devanagari) must still resolve via the old stack.
    expect(SUPER_TEXT_FONTS.sans.stack).toContain(SUPER_TEXT_FONT_STACK);
  });

  it("resolves a known key", () => {
    expect(resolveSuperTextFont("sans")).toBe(SUPER_TEXT_FONTS.sans);
    expect(resolveSuperTextFont("classic")).toBe(SUPER_TEXT_FONTS.classic);
  });

  it("falls back to classic for undefined, null and empty", () => {
    expect(resolveSuperTextFont(undefined)).toBe(SUPER_TEXT_FONTS.classic);
    expect(resolveSuperTextFont(null)).toBe(SUPER_TEXT_FONTS.classic);
    expect(resolveSuperTextFont("")).toBe(SUPER_TEXT_FONTS.classic);
  });

  it("falls back to classic for a CSS-injection attempt (never interpolates input)", () => {
    const evil = `Arial;background:url(https://evil.example/x);`;
    expect(resolveSuperTextFont(evil)).toBe(SUPER_TEXT_FONTS.classic);
    expect(resolveSuperTextFont(`x" onload="alert(1)`)).toBe(SUPER_TEXT_FONTS.classic);
  });

  it("is not fooled by prototype keys (uses an allowlist, not `in`)", () => {
    expect(resolveSuperTextFont("__proto__")).toBe(SUPER_TEXT_FONTS.classic);
    expect(resolveSuperTextFont("constructor")).toBe(SUPER_TEXT_FONTS.classic);
    expect(resolveSuperTextFont("toString")).toBe(SUPER_TEXT_FONTS.classic);
    expect(resolveSuperTextFont("valueOf")).toBe(SUPER_TEXT_FONTS.classic);
  });

  it("every registry stack is free of attribute-terminating double quotes", () => {
    // The stack is interpolated into style="…"; a double quote would break out.
    for (const key of SUPER_TEXT_FONT_KEYS) {
      expect(SUPER_TEXT_FONTS[key].stack).not.toContain('"');
    }
  });

  it("every registry entry declares a real bold weight (no synthetic bold)", () => {
    // Synthetic bold rasterises differently on macOS vs Alpine Chromium, which
    // would make the burn diverge from the preview even with identical bytes.
    for (const key of SUPER_TEXT_FONT_KEYS) {
      expect(SUPER_TEXT_FONTS[key].weight).toBe(700);
    }
  });
});

describe("superTextConfigSchema — font field", () => {
  it("accepts a config with NO font (every pre-existing draft and DB row)", () => {
    expect(superTextConfigSchema.safeParse(baseConfig).success).toBe(true);
  });

  it("does NOT inject a font key when absent — the burn cache hash must not shift", () => {
    const parsed = superTextConfigSchema.parse(baseConfig);
    expect("font" in parsed).toBe(false);
    // The worker keys S3 objects on sha1(JSON.stringify(parsed)); if zod
    // defaulted this field, every existing config would re-burn for nothing.
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(baseConfig));
  });

  it("accepts both supported font keys", () => {
    expect(superTextConfigSchema.safeParse({ ...baseConfig, font: "classic" }).success).toBe(true);
    expect(superTextConfigSchema.safeParse({ ...baseConfig, font: "sans" }).success).toBe(true);
  });

  it("rejects an unknown font key at the boundary", () => {
    expect(superTextConfigSchema.safeParse({ ...baseConfig, font: "comic-sans" }).success).toBe(
      false
    );
    expect(superTextConfigSchema.safeParse({ ...baseConfig, font: "__proto__" }).success).toBe(
      false
    );
  });

  it("rejects a font key carrying CSS (defence in depth with the resolver)", () => {
    const evil = { ...baseConfig, font: `Arial;background:url(https://evil.example/x)` };
    expect(superTextConfigSchema.safeParse(evil).success).toBe(false);
  });
});
