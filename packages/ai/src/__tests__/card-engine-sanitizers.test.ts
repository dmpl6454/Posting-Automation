import { describe, it, expect } from "vitest";
import {
  safeColor, safeImageUrl, escapeHtml,
  clampOpacity, safeFontFamily, safeAlign, safeShape, safeEmoji,
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
  it("safeFontFamily allowlists fonts", () => {
    expect(safeFontFamily("serif_display")).toBe("serif_display");
    expect(safeFontFamily("evil; }")).toBe("inter");
    expect(safeFontFamily(undefined)).toBe("inter");
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
