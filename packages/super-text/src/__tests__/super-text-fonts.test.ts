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
  SUPER_TEXT_EMOJI_STACK,
  EMBEDDED_SANS_FAMILY,
} from "../constants";
import {
  buildStripInnerHtml,
  buildSuperTextFrameHtml,
  buildSuperTextFontFaceCss,
  buildAllSuperTextFontFaceCss,
} from "../html";
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

  it("every registry entry declares a bold-or-heavier weight", () => {
    for (const key of SUPER_TEXT_FONT_KEYS) {
      expect(SUPER_TEXT_FONTS[key].weight).toBeGreaterThanOrEqual(700);
    }
  });

  it("an embedded face's @font-face weight MATCHES the spec weight (no synthetic bold)", () => {
    // The real invariant, rather than a hardcoded number: if the declared
    // font-weight and the @font-face weight disagree, Chromium synthesises bold —
    // and synthetic-bold rasterisation differs between macOS and Alpine, so the
    // burn would diverge from the preview even with identical font bytes.
    for (const key of SUPER_TEXT_FONT_KEYS) {
      const spec = SUPER_TEXT_FONTS[key];
      if (!spec.embedded?.base64) continue;
      expect(buildSuperTextFontFaceCss(key)).toContain(`font-weight:${spec.weight}`);
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

describe("buildSuperTextFontFaceCss", () => {
  it("emits nothing for classic — no @font-face, nothing to load", () => {
    expect(buildSuperTextFontFaceCss("classic")).toBe("");
    expect(buildSuperTextFontFaceCss(undefined)).toBe("");
    expect(buildSuperTextFontFaceCss(null)).toBe("");
  });

  it("emits a data-URI face for sans at its declared weight, with font-display:block", () => {
    const css = buildSuperTextFontFaceCss("sans");
    expect(css).toContain(`font-family:'${EMBEDDED_SANS_FAMILY}'`);
    expect(css).toContain(`font-weight:${SUPER_TEXT_FONTS.sans.weight}`);
    // `block`, not `swap`: swap would let the user position the strip against
    // fallback metrics and then reflow underneath them.
    expect(css).toContain("font-display:block");
    expect(css).toContain("src:url(data:font/woff2;base64,");
    expect(css).toContain("format('woff2')");
  });

  it("never emits an empty data URI", () => {
    // Guards a botched regeneration of the payload file.
    for (const key of SUPER_TEXT_FONT_KEYS) {
      expect(buildSuperTextFontFaceCss(key)).not.toContain("base64,)");
    }
  });

  it("carries a real payload (the generated file is not empty)", () => {
    // A gitignored or unrun generator would silently ship an empty font.
    expect(buildSuperTextFontFaceCss("sans").length).toBeGreaterThan(5000);
  });

  it("buildAll emits every font's face in one string", () => {
    expect(buildAllSuperTextFontFaceCss()).toContain(EMBEDDED_SANS_FAMILY);
  });

  it("an injecting key emits no face at all", () => {
    expect(buildSuperTextFontFaceCss(`x';}@font-face{src:url(https://evil/x)`)).toBe("");
  });

  it("contains no markup characters, so it is safe as a <style> TEXT child", () => {
    // apps/web/components/content-agent/super-text-font-faces.tsx renders this
    // as a text child rather than via dangerouslySetInnerHTML. React would
    // escape < > & inside textContent and corrupt the CSS, and any of those
    // characters would also mean the string could carry markup. Neither is true:
    // the payload is base64 (A-Za-z0-9+/=) plus CSS punctuation.
    const css = buildAllSuperTextFontFaceCss();
    expect(css).not.toContain("<");
    expect(css).not.toContain(">");
    expect(css).not.toContain("&");
    expect(css).not.toContain("</style");
  });
});

describe("font application — byte identity and parity", () => {
  it("a config with NO font renders identically to font:'classic'", () => {
    expect(buildStripInnerHtml(baseConfig)).toBe(
      buildStripInnerHtml({ ...baseConfig, font: "classic" })
    );
  });

  it("classic emits NO letter-spacing declaration at all", () => {
    // A `letter-spacing:0em` would still be a byte change vs the pre-picker output.
    expect(buildStripInnerHtml(baseConfig)).not.toContain("letter-spacing");
  });

  it("sans applies the embedded family and the tightened tracking", () => {
    const html = buildStripInnerHtml({ ...baseConfig, font: "sans" });
    expect(html).toContain(EMBEDDED_SANS_FAMILY);
    expect(html).toContain("letter-spacing:-0.02em");
  });

  it("EVERY font key still appends the emoji stack (or emoji burn as tofu)", () => {
    for (const font of SUPER_TEXT_FONT_KEYS) {
      expect(buildStripInnerHtml({ ...baseConfig, font })).toContain(SUPER_TEXT_EMOJI_STACK);
    }
  });

  it("every font key keeps the classic stack in its fallback chain (non-Latin)", () => {
    // Devanagari has no DM Sans coverage; it must fall through, as it does today.
    const html = buildStripInnerHtml({
      ...baseConfig,
      segments: [{ text: "नमस्ते" }],
      font: "sans",
    });
    expect(html).toContain("Liberation Sans");
    expect(html).toContain("नमस्ते");
  });

  it("an injecting font value cannot reach the style attribute", () => {
    const html = buildStripInnerHtml({
      ...baseConfig,
      // Bypasses zod exactly like a hand-written DB row would.
      font: `Arial;background:url(https://evil.example/x)` as never,
    });
    expect(html).not.toContain("evil.example");
    expect(html).toBe(buildStripInnerHtml(baseConfig)); // silently classic
  });

  it("the burn frame carries the @font-face for sans and none for classic", () => {
    expect(buildSuperTextFrameHtml({ ...baseConfig, font: "sans" }, 1080, 1920)).toContain(
      "@font-face"
    );
    expect(buildSuperTextFrameHtml(baseConfig, 1080, 1920)).not.toContain("@font-face");
  });

  it("the burn frame declares @font-face BEFORE the rules that use it", () => {
    const html = buildSuperTextFrameHtml({ ...baseConfig, font: "sans" }, 1080, 1920);
    expect(html.indexOf("@font-face")).toBeLessThan(html.indexOf(".anchor{"));
  });
});
