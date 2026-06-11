import { describe, it, expect } from "vitest";
import { buildStaticCreative, type StaticCreativeOptions } from "../tools/creative-templates";

/**
 * Carousel consistency (C4): EVERY slide — cover, body, cta — must render through
 * the SAME branded template so the whole set shares one visual grammar (brand
 * accent rule, logo/handle chrome, theme tokens). slideRole selects the layout.
 */
describe("creative-templates slideRole (carousel consistency)", () => {
  const body: StaticCreativeOptions = {
    style: "premium_editorial",
    slideRole: "body",
    headline: "Heading",
    body: "This is the body paragraph",
    theme: "light",
    channelName: "X",
    handle: "x",
    brandColor: "#e11d48",
    logoPosition: "top-right",
  };

  it("body slide renders the escaped body text inside the brand chrome", () => {
    const html = buildStaticCreative({ ...body });
    expect(html).toContain("<!DOCTYPE html>");
    // The focus is the body paragraph.
    expect(html).toContain("This is the body paragraph");
    // Brand chrome the cover also has: the accent rule + the brand handle/name.
    expect(html).toContain("class=\"rule\"");
    expect(html).toContain("#e11d48");
    expect(html).toContain("x"); // handle
    expect(html).toContain("width:1080px");
    expect(html).toContain("height:1350px");
  });

  it("cta slide renders a Follow call-to-action affordance", () => {
    const html = buildStaticCreative({
      ...body,
      slideRole: "cta",
      headline: "Follow for More",
      body: "",
    });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Follow");
    // Still wears the same brand chrome (brand accent color + accent rule affordance).
    expect(html).toContain("#e11d48");
    expect(html).toContain("cta-rule");
  });

  it("escapes HTML-special chars in the body (no script injection)", () => {
    const html = buildStaticCreative({
      ...body,
      body: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("undefined slideRole behaves as cover (back-compat for the static single-image path)", () => {
    const cover = buildStaticCreative({
      style: "premium_editorial",
      headline: "Krrish 4 Budget Controversy Debunked",
      channelName: "Moviefied",
      handle: "@moviefied",
      logoPosition: "top-right",
    });
    expect(cover).toContain("Krrish 4 Budget Controversy Debunked");
    // No body text block is forced when slideRole is undefined.
    expect(cover).toContain("class=\"headline\"");
  });

  it("body slide works across styles (shared chrome) — hook_bars", () => {
    const html = buildStaticCreative({
      ...body,
      style: "hook_bars",
      body: "Body text for a hook_bars body slide",
    });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Body text for a hook_bars body slide");
  });

  // 2026-06-11 regression: carousel body/cta slides with NO photo were rendering
  // on a flat near-white #f7f7f8 fill that read as "blank" (the user's slide 2/3
  // bug). A photoless body/cta slide must force the gradient theme — white text
  // on a rich brand gradient — never the flat near-white fill.
  it("body slide with NO photo + light theme falls back to a branded gradient (never blank-white)", () => {
    const html = buildStaticCreative({ ...body }); // no bgImageUrl
    expect(html).toContain("linear-gradient(");
    expect(html).toContain("#ffffff"); // white text for legibility over the gradient
    expect(html).not.toContain(".bg{position:absolute;inset:0;background:#f7f7f8;}");
  });

  it("cta slide with NO photo + light theme falls back to a branded gradient (never blank-white)", () => {
    const html = buildStaticCreative({
      ...body,
      slideRole: "cta",
      headline: "Follow for More",
      body: "",
    });
    expect(html).toContain("linear-gradient(");
    expect(html).toContain("#ffffff");
    expect(html).not.toContain(".bg{position:absolute;inset:0;background:#f7f7f8;}");
  });

  it("body slide WITH a photo honors the requested light theme (dark text + photo bg)", () => {
    const html = buildStaticCreative({
      ...body,
      bgImageUrl: "https://cdn.example.com/photo.jpg",
    });
    expect(html).toContain("https://cdn.example.com/photo.jpg");
    expect(html).toContain("#0f1419"); // dark text (light theme honored over the photo+scrim)
  });
});
