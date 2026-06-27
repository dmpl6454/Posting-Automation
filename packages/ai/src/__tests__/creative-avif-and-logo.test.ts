/**
 * Regression guards for the 2026-06-27 Repurpose render fixes:
 *  1. AVIF heroes must be accepted by safeImageUrl (news CDNs content-negotiate
 *     avif). Before: rejected → blank gradient card.
 *  2. No fabricated logo: with no logoUrl AND suppressLogoFallback, the static
 *     creative renders NO monogram/initial (the phantom "m" circle). Default
 *     (no flag) keeps the legacy monogram so NewsGrid/autopilot are unaffected.
 */
import { describe, it, expect } from "vitest";
import { safeImageUrl, buildStaticCreative } from "../tools/creative-templates";

describe("safeImageUrl — AVIF support", () => {
  it("accepts data:image/avif (the CDN-negotiated hero)", () => {
    expect(safeImageUrl("data:image/avif;base64,AAAA")).toBe("data:image/avif;base64,AAAA");
  });
  it("still accepts png/jpeg/webp/https", () => {
    expect(safeImageUrl("data:image/png;base64,AAAA")).toBeTruthy();
    expect(safeImageUrl("data:image/jpeg;base64,AAAA")).toBeTruthy();
    expect(safeImageUrl("data:image/webp;base64,AAAA")).toBeTruthy();
    expect(safeImageUrl("https://cdn/x.jpg")).toBe("https://cdn/x.jpg");
  });
  it("still REJECTS svg+xml (active content / XSS) and breakout chars", () => {
    expect(safeImageUrl("data:image/svg+xml;base64,AAAA")).toBeNull();
    expect(safeImageUrl(`data:image/png;base64,a")<script>`)).toBeNull();
  });
});

describe("buildStaticCreative — avif hero is embedded, not dropped", () => {
  it("emits the avif data URI as the background-image (was previously stripped → gradient)", () => {
    const html = buildStaticCreative({
      style: "premium_editorial",
      headline: "Israel and Lebanon",
      channelName: "Moviefied",
      bgImageUrl: "data:image/avif;base64,QQQQ",
      theme: "dark",
    } as any);
    expect(/background-image:url\(["']?data:image\/avif;base64,QQQQ/.test(html)).toBe(true);
  });
});

describe("buildStaticCreative — no fabricated logo", () => {
  const base = {
    style: "premium_editorial" as const,
    headline: "Hello world",
    channelName: "Moviefied",
    bgImageUrl: "data:image/png;base64,ZZZZ",
    theme: "dark" as const,
  };

  it("with suppressLogoFallback + no logoUrl → renders NO monogram initial", () => {
    const html = buildStaticCreative({ ...base, suppressLogoFallback: true } as any);
    // The monogram is a brand-color square containing the first initial "M".
    // With suppression it must be absent. Assert no standalone initial badge.
    // (The brand NAME label may still appear as text; we only forbid the logo monogram.)
    const logoBlock = html.match(/<div class="logo">([\s\S]*?)<\/div>/);
    const inner = logoBlock?.[1] ?? "";
    expect(inner.trim()).toBe(""); // empty logo wrapper — no fabricated mark
  });

  it("WITHOUT the flag (legacy default) → keeps the monogram (NewsGrid/autopilot unaffected)", () => {
    const html = buildStaticCreative({ ...base } as any);
    const logoBlock = html.match(/<div class="logo">([\s\S]*?)<\/div>/);
    const inner = logoBlock?.[1] ?? "";
    expect(inner).toContain("M"); // legacy monogram initial preserved
  });

  it("with a real logoUrl → always renders the logo image (regardless of flag)", () => {
    const html = buildStaticCreative({ ...base, suppressLogoFallback: true, logoUrl: "https://cdn/logo.png" } as any);
    expect(html).toContain('<img src="https://cdn/logo.png"');
  });
});
