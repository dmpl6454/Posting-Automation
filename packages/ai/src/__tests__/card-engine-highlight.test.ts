import { describe, it, expect } from "vitest";
import { renderHighlightMarkup, DEFAULT_ACCENT } from "../tools/card-engine";

describe("renderHighlightMarkup", () => {
  it("renders [[text]] in accent color, text mode", () => {
    const html = renderHighlightMarkup("Hello [[World]]", "#00ff00");
    expect(html).toContain("Hello ");
    expect(html).toContain(`color:#00ff00`);
    expect(html).toContain(">World</span>");
  });

  it("renders [[text|#hex]] with explicit color", () => {
    const html = renderHighlightMarkup("[[Red|#ff0000]] now", "#000000");
    expect(html).toContain("color:#ff0000"); // explicit per-span color, not the accent
    expect(html).toContain(">Red</span>");
  });

  it("renders [[text|#hex|box]] as a solid highlight box", () => {
    const html = renderHighlightMarkup("[[Boxed|#ffcc00|box]] word", "#000000");
    expect(html).toContain("background:#ffcc00");
    expect(html).toContain(">Boxed</span>");
    expect(html).not.toContain("color:#ffcc00;background:transparent"); // it's box mode
  });

  it("supports multiple independently-colored spans in one line", () => {
    const html = renderHighlightMarkup("[[A|#111]] and [[B|#222|box]]", "#999999");
    expect(html).toContain("color:#111");
    expect(html).toContain("background:#222");
  });

  it("maps legacy **text** to default-accent text mode", () => {
    const html = renderHighlightMarkup("TMC ka **Pushpa** rises", "#e11d48");
    expect(html).toContain(`color:#e11d48`);
    expect(html).toContain(">Pushpa</span>");
  });

  it("escapes plain text and span text (no XSS, no attribute breakout)", () => {
    const html = renderHighlightMarkup(`<img onerror=x> [[a<b>c]] & "z"`, DEFAULT_ACCENT);
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;b&gt;");
  });

  it("rejects a malicious span color (injection) and uses default accent", () => {
    const html = renderHighlightMarkup(`[[x|#fff" onload=alert(1)]]`, DEFAULT_ACCENT);
    expect(html).not.toContain("onload=alert(1)");
    expect(html).toContain(`color:${DEFAULT_ACCENT}`);
  });

  it("leaves unbalanced markup as escaped literal text", () => {
    const html = renderHighlightMarkup("Half [[open span here", DEFAULT_ACCENT);
    expect(html).toContain("[[open span here");
    expect(html).not.toContain("<span");
  });
});
