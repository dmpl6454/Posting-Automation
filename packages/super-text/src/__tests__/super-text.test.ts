/**
 * Super text — config schema + the SINGLE strip-HTML builder shared by the
 * compose preview and the worker burn.
 *
 * The security suite here is the analogue of creative-templates.test.ts: this
 * builder's output is injected with dangerouslySetInnerHTML in the browser AND
 * fed to Puppeteer in the worker, so escaping/colour validation is load-bearing.
 * User text NEVER reaches the DOM unescaped and colours are #RRGGBB-only.
 */
import { describe, it, expect } from "vitest";
import {
  superTextConfigSchema,
  superTextMapSchema,
  buildStripInnerHtml,
  buildSuperTextFrameHtml,
  safeHexColor,
  escapeHtml,
  SUPER_TEXT_DEFAULTS,
  type SuperTextConfig,
} from "../index";

const base: SuperTextConfig = {
  version: 1,
  segments: [{ text: "Ranveer" }, { text: "with" }, { text: "Yalina😍✨", color: "#EF4444" }],
  stripColor: "#FFFFFF",
  textColor: "#111111",
  xPct: 50,
  yPct: 72,
  fontSizePct: 4.2,
};

describe("superTextConfigSchema", () => {
  it("accepts a valid config, emoji included", () => {
    expect(superTextConfigSchema.safeParse(base).success).toBe(true);
  });

  it("rejects colours that are not #RRGGBB (CSS-injection vector)", () => {
    for (const bad of ["red", "rgb(1,2,3)", "#fff", "url(javascript:1)", "#111111;}</style><script>"]) {
      expect(superTextConfigSchema.safeParse({ ...base, stripColor: bad }).success).toBe(false);
      expect(
        superTextConfigSchema.safeParse({ ...base, segments: [{ text: "x", color: bad }] }).success
      ).toBe(false);
    }
  });

  it("rejects out-of-range geometry", () => {
    expect(superTextConfigSchema.safeParse({ ...base, yPct: 120 }).success).toBe(false);
    expect(superTextConfigSchema.safeParse({ ...base, yPct: 0 }).success).toBe(false);
    expect(superTextConfigSchema.safeParse({ ...base, xPct: -5 }).success).toBe(false);
    expect(superTextConfigSchema.safeParse({ ...base, fontSizePct: 20 }).success).toBe(false);
    expect(superTextConfigSchema.safeParse({ ...base, fontSizePct: 0.5 }).success).toBe(false);
  });

  it("caps total text at 150 characters and 30 segments", () => {
    const long = { ...base, segments: Array.from({ length: 20 }, () => ({ text: "aaaaaaaaaa" })) };
    expect(superTextConfigSchema.safeParse(long).success).toBe(false);
    const tooMany = { ...base, segments: Array.from({ length: 31 }, () => ({ text: "a" })) };
    expect(superTextConfigSchema.safeParse(tooMany).success).toBe(false);
  });

  it("requires at least one segment and rejects an empty one", () => {
    expect(superTextConfigSchema.safeParse({ ...base, segments: [] }).success).toBe(false);
    expect(superTextConfigSchema.safeParse({ ...base, segments: [{ text: "" }] }).success).toBe(false);
  });

  it("superTextMapSchema validates a mediaId → config map", () => {
    expect(superTextMapSchema.safeParse({ "media-1": base }).success).toBe(true);
    expect(superTextMapSchema.safeParse({ "media-1": { ...base, xPct: 999 } }).success).toBe(false);
  });
});

describe("buildStripInnerHtml — XSS / injection safety", () => {
  it("escapes HTML in segment text", () => {
    const html = buildStripInnerHtml({
      ...base,
      segments: [{ text: '<script>alert(1)</script>' }],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes quotes so an attribute cannot be broken out of", () => {
    const html = buildStripInnerHtml({
      ...base,
      segments: [{ text: '" onmouseover="evil()' }],
    });
    expect(html).not.toContain('" onmouseover="');
    expect(html).toContain("&quot;");
  });

  it("falls back to a safe colour if an invalid one bypasses the schema", () => {
    const html = buildStripInnerHtml({
      ...base,
      // Simulates a hand-written DB row / tampered draft.
      stripColor: "red;}</style><script>x()</script>" as any,
      segments: [{ text: "hi", color: "javascript:alert(1)" as any }],
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("background:#FFFFFF");
  });
});

describe("buildStripInnerHtml — the Instagram look", () => {
  it("renders the strip background, per-word colours and cloned pill wrapping", () => {
    const html = buildStripInnerHtml(base);
    expect(html).toContain("background:#FFFFFF");
    expect(html).toContain("color:#EF4444"); // the highlighted word
    expect(html).toContain("box-decoration-break:clone");
    expect(html).toContain("😍✨"); // emoji survive untouched
  });

  it("segments with no override inherit the default text colour", () => {
    const html = buildStripInnerHtml(base);
    expect(html).toContain(">Ranveer</span>");
    expect(html).toContain("color:#111111");
  });
});

describe("buildSuperTextFrameHtml — burn frame", () => {
  it("matches the video's pixel size and scales the font off its WIDTH", () => {
    const html = buildSuperTextFrameHtml(base, 720, 1280);
    expect(html).toContain("width:720px");
    expect(html).toContain("height:1280px");
    expect(html).toContain(`font-size:${Math.round((4.2 / 100) * 720)}px`);
  });

  it("positions by percentage so preview and burn agree", () => {
    const html = buildSuperTextFrameHtml(base, 1080, 1920);
    expect(html).toContain("left:50%");
    expect(html).toContain("top:72%");
    expect(html).toContain("translate(-50%,-50%)");
  });

  it("is transparent (composited over the video, not a background)", () => {
    expect(buildSuperTextFrameHtml(base, 720, 1280)).toContain("background:transparent");
  });

  it("clamps absurd dimensions and out-of-range positions", () => {
    const html = buildSuperTextFrameHtml({ ...base, xPct: 99, yPct: 1 }, 0, 999999);
    expect(html).toContain("width:16px");
    expect(html).toContain("height:7680px");
    expect(html).toContain("left:95%");
    expect(html).toContain("top:5%");
  });
});

describe("helpers", () => {
  it("safeHexColor only passes #RRGGBB", () => {
    expect(safeHexColor("#ff0000", "#111111")).toBe("#ff0000");
    expect(safeHexColor("#FFF", "#111111")).toBe("#111111");
    expect(safeHexColor(undefined, "#111111")).toBe("#111111");
    expect(safeHexColor(null, "#111111")).toBe("#111111");
  });

  it("escapeHtml covers the five dangerous characters", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("defaults are a valid config when combined with text", () => {
    const cfg = { version: 1 as const, segments: [{ text: "hi" }], ...SUPER_TEXT_DEFAULTS };
    expect(superTextConfigSchema.safeParse(cfg).success).toBe(true);
  });
});
