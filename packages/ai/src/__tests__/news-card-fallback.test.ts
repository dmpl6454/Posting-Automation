import { describe, it, expect } from "vitest";
import { generateStaticNewsCreativeHtml } from "../tools/news-card-template";

const base = {
  headline: "Big news today about something important",
  channelName: "Acme News",
  handle: "@acme",
  template: "breaking_news" as const,
  // no backgroundImageUrl → exercises the fallback
};

describe("NewsGrid no-photo fallback (NG-1)", () => {
  it("does NOT reference a site-root-relative SVG (unresolvable under about:blank)", () => {
    const html = generateStaticNewsCreativeHtml(base);
    expect(html).not.toMatch(/url\(\/newsgrid-bg\//);
  });
  it("uses a self-contained CSS gradient fallback so the card is never pure-black", () => {
    const html = generateStaticNewsCreativeHtml(base);
    expect(html).toMatch(/linear-gradient/);
  });
  it("still uses a real background image when one is provided (happy path unchanged)", () => {
    const html = generateStaticNewsCreativeHtml({
      ...base,
      backgroundImageUrl: "data:image/png;base64,AAAA",
    });
    expect(html).toContain("data:image/png;base64,AAAA");
  });
  it("emits the gradient BEFORE background-image so a real photo overrides it (not wiped by the `background:` shorthand)", () => {
    // CSS `background:` is a shorthand that resets background-image to none, so the
    // gradient MUST come first and the photo's background-image second, or every
    // real NewsGrid photo would be silently replaced by the flat gradient.
    const html = generateStaticNewsCreativeHtml({
      ...base,
      backgroundImageUrl: "data:image/png;base64,ZZZ",
    });
    const rule = html.match(/\.bg-photo\{[^}]*\}/)?.[0] ?? "";
    const gradientIdx = rule.indexOf("background:");
    const photoIdx = rule.indexOf("background-image:url(data:image/png;base64,ZZZ)");
    expect(gradientIdx).toBeGreaterThanOrEqual(0);
    expect(photoIdx).toBeGreaterThan(gradientIdx);
  });
});
