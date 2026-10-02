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
  superTextAnchorCss,
  resolveSuperTextLayout,
  resolveSuperTextScope,
  SUPER_TEXT_LAYOUTS,
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

/* ─── Layout preset + scope (2026-10-02) ─────────────────────────────────── */
describe("layout preset — byte identity and the insta geometry", () => {
  it("a config with NO layout renders identically to layout:'classic'", () => {
    expect(buildStripInnerHtml(base)).toBe(buildStripInnerHtml({ ...base, layout: "classic" }));
    expect(buildSuperTextFrameHtml(base, 1080, 1920)).toBe(
      buildSuperTextFrameHtml({ ...base, layout: "classic" }, 1080, 1920)
    );
  });

  it("classic anchor css is exactly the pre-preset values (no width key)", () => {
    expect(superTextAnchorCss({})).toEqual({ maxWidth: "88%", textAlign: "center" });
    expect(superTextAnchorCss({ layout: "classic" })).toEqual({ maxWidth: "88%", textAlign: "center" });
  });

  it("insta: centred block, LEFT-aligned lines, max-content width, pill budget minus one pad", () => {
    const spec = SUPER_TEXT_LAYOUTS.insta;
    expect(superTextAnchorCss({ layout: "insta" })).toEqual({
      width: "max-content",
      maxWidth: `calc(${spec.maxWidthPct}% - ${spec.padXEm}em)`,
      textAlign: "left",
    });
    const html = buildSuperTextFrameHtml({ ...base, layout: "insta" }, 1080, 1920);
    expect(html).toContain("width:max-content;");
    expect(html).toContain("text-align:left;");
    // The block is still anchored by its CENTRE — dragging in the editor is unchanged.
    expect(html).toContain("transform:translate(-50%,-50%)");
    const strip = buildStripInnerHtml({ ...base, layout: "insta" });
    expect(strip).toContain(`line-height:${spec.lineHeight};`);
    expect(strip).toContain(`padding:${spec.padYEm}em ${spec.padXEm}em;`);
    expect(strip).toContain(`border-radius:${spec.radiusEm}em;`);
  });

  it("resolves by allowlist — unknown, injected and prototype keys fall back to classic", () => {
    const classic = resolveSuperTextLayout("classic");
    for (const k of [undefined, null, "", "bogus", "insta;}</style>", "__proto__", "constructor", "toString"]) {
      expect(resolveSuperTextLayout(k as any)).toBe(classic);
    }
    expect(resolveSuperTextLayout("insta")).toBe(SUPER_TEXT_LAYOUTS.insta);
  });

  it("schema: layout/scope/introSeconds are optional, closed enums, never injected", () => {
    const parsed = superTextConfigSchema.parse(base);
    expect("layout" in parsed).toBe(false);
    expect("scope" in parsed).toBe(false);
    expect(superTextConfigSchema.safeParse({ ...base, layout: "insta", scope: "cover" }).success).toBe(true);
    expect(superTextConfigSchema.safeParse({ ...base, scope: "intro", introSeconds: 4 }).success).toBe(true);
    expect(superTextConfigSchema.safeParse({ ...base, layout: "weird" }).success).toBe(false);
    expect(superTextConfigSchema.safeParse({ ...base, scope: "thumbnail" }).success).toBe(false);
    expect(superTextConfigSchema.safeParse({ ...base, scope: "intro", introSeconds: 0 }).success).toBe(false);
    expect(superTextConfigSchema.safeParse({ ...base, scope: "intro", introSeconds: 31 }).success).toBe(false);
  });

  it("scope resolves to 'video' (the original burn) for anything but a known key", () => {
    expect(resolveSuperTextScope(undefined)).toBe("video");
    expect(resolveSuperTextScope("cover")).toBe("cover");
    expect(resolveSuperTextScope("intro")).toBe("intro");
    expect(resolveSuperTextScope("__proto__")).toBe("video");
  });

  it("new-strip defaults follow the reference clip: insta layout, sans, cover scope, lower third", () => {
    expect(SUPER_TEXT_DEFAULTS).toMatchObject({ layout: "insta", font: "sans", scope: "cover", yPct: 84 });
  });
});
