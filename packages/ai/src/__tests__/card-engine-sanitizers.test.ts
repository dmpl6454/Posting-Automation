import { describe, it, expect } from "vitest";
import {
  safeColor, safeImageUrl, escapeHtml,
  clampOpacity, safeFontFamily, safeAlign, safeShape, safeEmoji,
  fontStack, FONT_OPTIONS,
  DEFAULT_ACCENT,
} from "../tools/card-engine";

describe("safeColor", () => {
  it("accepts valid hex", () => {
    expect(safeColor("#e11d48")).toBe("#e11d48");
    expect(safeColor("#fff")).toBe("#fff");
  });
  it("rejects injection and falls back to default accent", () => {
    expect(safeColor('red;}</style><script>alert(1)</script>')).toBe(DEFAULT_ACCENT);
    expect(safeColor(undefined)).toBe(DEFAULT_ACCENT);
  });
});

describe("safeImageUrl", () => {
  it("accepts https + data:image", () => {
    expect(safeImageUrl("https://cdn.x/a.png?q=1")).toBe("https://cdn.x/a.png?q=1");
    expect(safeImageUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  });
  it("rejects breakout chars and non-image schemes", () => {
    expect(safeImageUrl(`https://x/a.png);}</style><script>`)).toBeNull();
    expect(safeImageUrl("javascript:alert(1)")).toBeNull();
    expect(safeImageUrl(null)).toBeNull();
  });
});

describe("escapeHtml", () => {
  it("escapes &<>\" and single quote", () => {
    expect(escapeHtml(`<b>"x"</b> & 'y'`)).toBe(`&lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; &#39;y&#39;`);
  });
});

describe("clampOpacity", () => {
  it("clamps to [0,100] and defaults non-numbers", () => {
    expect(clampOpacity(50)).toBe(50);
    expect(clampOpacity(-10)).toBe(0);
    expect(clampOpacity(250)).toBe(100);
    expect(clampOpacity(undefined, 80)).toBe(80);
    expect(clampOpacity(NaN, 100)).toBe(100);
  });
});

describe("enum guards", () => {
  it("safeFontFamily allowlists original 3 fonts (regression: existing callers unchanged)", () => {
    expect(safeFontFamily("inter")).toBe("inter");
    expect(safeFontFamily("serif_display")).toBe("serif_display");
    expect(safeFontFamily("condensed")).toBe("condensed");
    expect(safeFontFamily("evil; }")).toBe("inter");
    expect(safeFontFamily(undefined)).toBe("inter");
  });

  it("safeFontFamily accepts all Round 15 additions", () => {
    const newFonts = [
      "montserrat", "poppins", "bebas", "anton", "archivo_black",
      "dm_serif", "lora", "roboto_slab", "bitter", "space_grotesk", "libre_franklin",
    ] as const;
    for (const f of newFonts) {
      expect(safeFontFamily(f)).toBe(f);
    }
  });

  it("FONT_OPTIONS has 14 entries (3 original + 11 new)", () => {
    expect(FONT_OPTIONS.length).toBe(14);
  });

  it("FONT_OPTIONS first three entries are the original fonts in order", () => {
    expect(FONT_OPTIONS[0]!.value).toBe("inter");
    expect(FONT_OPTIONS[1]!.value).toBe("serif_display");
    expect(FONT_OPTIONS[2]!.value).toBe("condensed");
  });

  it("FONT_OPTIONS values are all unique and accepted by safeFontFamily", () => {
    const seen = new Set<string>();
    for (const { value } of FONT_OPTIONS) {
      expect(seen.has(value)).toBe(false); // no duplicates
      seen.add(value);
      expect(safeFontFamily(value)).toBe(value); // every value is allowlisted
    }
  });

  it("fontStack returns a string for every FONT_OPTIONS value (no missing cases)", () => {
    for (const { value } of FONT_OPTIONS) {
      const stack = fontStack(value);
      expect(typeof stack).toBe("string");
      expect(stack.length).toBeGreaterThan(0);
    }
  });

  it("fontStack original 3 stacks are unchanged (regression guard)", () => {
    expect(fontStack("inter")).toContain("Inter");
    expect(fontStack("serif_display")).toContain("Playfair Display");
    expect(fontStack("condensed")).toContain("Oswald");
  });
  it("safeAlign / safeShape enums", () => {
    expect(safeAlign("center")).toBe("center");
    expect(safeAlign("right")).toBe("left");
    expect(safeShape("bar")).toBe("bar");
    expect(safeShape("octagon")).toBe("pill");
  });
  it("safeEmoji passes a short emoji and drops markup", () => {
    expect(safeEmoji("🚨")).toBe("🚨");
    expect(safeEmoji(`"><script>`)).toBe("");
    expect(safeEmoji("ABCDEFGHIJ")).toBe(""); // too long / not emoji range
  });
});
