import { describe, it, expect } from "vitest";
import {
  renderBackground, DEFAULT_CONTROLS,
  type BackgroundBlockProps, type StyleControls,
} from "../tools/card-engine";

const C: StyleControls = { ...DEFAULT_CONTROLS };

describe("renderBackground", () => {
  it("photo mode uses the sanitized image as cover bg", () => {
    const html = renderBackground({ mode: "photo", imageUrl: "https://cdn.x/p.jpg" }, C);
    expect(html).toContain("https://cdn.x/p.jpg");
    expect(html).toContain("background-size:cover");
  });

  it("photo mode with a malicious url falls back to gradient (no breakout)", () => {
    const html = renderBackground(
      { mode: "photo", imageUrl: `https://x/p.jpg);}</style><script>alert(1)</script>` },
      C,
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("linear-gradient(");
  });

  it("ai mode renders the provided AI image like a photo", () => {
    const html = renderBackground({ mode: "ai", imageUrl: "data:image/png;base64,AAAA" }, C);
    expect(html).toContain("data:image/png;base64,AAAA");
  });

  it("gradient mode renders a branded gradient from the controls brand color", () => {
    const html = renderBackground({ mode: "gradient" }, { ...C, brandColor: "#123456" });
    expect(html).toContain("#123456");
    expect(html).toContain("linear-gradient(");
  });

  it("splitPhotos renders a 2-up grid when two images are present", () => {
    const html = renderBackground(
      { mode: "splitPhotos", imageUrls: ["https://x/a.jpg", "https://x/b.jpg"] }, C);
    expect(html).toContain("https://x/a.jpg");
    expect(html).toContain("https://x/b.jpg");
    expect(html).toContain("grid-template-columns:1fr 1fr");
  });

  it("photoGrid renders up to 4 tiles", () => {
    const html = renderBackground(
      { mode: "photoGrid", imageUrls: ["https://x/1.jpg","https://x/2.jpg","https://x/3.jpg","https://x/4.jpg"] }, C);
    expect((html.match(/https:\/\/x\//g) || []).length).toBe(4);
  });

  it("topTextBottomPhoto renders an escaped text band + photo", () => {
    const html = renderBackground(
      { mode: "topTextBottomPhoto", imageUrl: "https://x/p.jpg", overlayText: "<b>BIG</b>" }, C);
    expect(html).toContain("&lt;b&gt;BIG");
    expect(html).toContain("https://x/p.jpg");
  });

  it("screenshot mode renders a device frame around the image", () => {
    const html = renderBackground({ mode: "screenshot", imageUrl: "https://x/ui.jpg" }, C);
    expect(html).toContain("https://x/ui.jpg");
    expect(html).toContain("screenshot-frame");
  });

  it("subjectComposite with no image degrades to gradient (never broken slot)", () => {
    const html = renderBackground({ mode: "subjectComposite" }, C);
    expect(html).toContain("linear-gradient(");
  });
});

import { renderLogo, type LogoBlockProps } from "../tools/card-engine";

describe("renderLogo", () => {
  it("renders an image logo with sanitized src", () => {
    const html = renderLogo({ logos: [{ kind: "image", src: "https://cdn.x/logo.png", anchor: "tr", size: 8, opacity: 100 }] }, C);
    expect(html).toContain("https://cdn.x/logo.png");
  });
  it("renders a wordmark with escaped text", () => {
    const html = renderLogo({ logos: [{ kind: "wordmark", text: "BOLLYWOOD <CHRONICLE>", anchor: "bl", size: 10, opacity: 100 }] }, C);
    expect(html).toContain("BOLLYWOOD &lt;CHRONICLE&gt;");
  });
  it("renders a monogram", () => {
    const html = renderLogo({ logos: [{ kind: "monogram", text: "DS", anchor: "tl", size: 6, opacity: 100 }] }, C);
    expect(html).toContain(">DS<");
  });
  it("renders multiple independently-anchored logos", () => {
    const html = renderLogo({ logos: [
      { kind: "wordmark", text: "MAM", anchor: "tl", size: 8, opacity: 100 },
      { kind: "image", src: "https://cdn.x/kfc.png", anchor: "br", size: 12, opacity: 100 },
    ] }, C);
    expect(html).toContain("MAM");
    expect(html).toContain("https://cdn.x/kfc.png");
  });
  it("renders a faint watermark at reduced opacity", () => {
    const html = renderLogo({ logos: [{ kind: "wordmark", text: "WM", anchor: "mc", size: 30, opacity: 12, watermark: true }] }, C);
    expect(html).toContain("opacity:0.12");
  });
  it("clamps an out-of-range size and rejects a malicious box bg", () => {
    const html = renderLogo({ logos: [{ kind: "wordmark", text: "X", anchor: "tr", size: 999, opacity: 100, box: { bg: "red;}</style>", opacity: 100, radius: 8, pad: 6 } }] }, C);
    expect(html).not.toContain("red;}</style>");
    expect(html).not.toMatch(/width:999%/);
  });
  it("emits nothing for an empty logo array", () => {
    expect(renderLogo({ logos: [] }, C)).toBe("");
  });
  it("drops a logo with a malicious src (no image emitted) but keeps valid siblings", () => {
    const html = renderLogo({ logos: [
      { kind: "image", src: `https://x/a.png"><script>alert(1)</script>`, anchor: "tr", size: 8, opacity: 100 },
      { kind: "wordmark", text: "OK", anchor: "tl", size: 8, opacity: 100 },
    ] }, C);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("OK");
  });
});

import { renderCircularInset, type CircularInsetBlockProps } from "../tools/card-engine";

describe("renderCircularInset", () => {
  it("renders a single circular inset with a colored ring", () => {
    const html = renderCircularInset({ items: [{ imageUrl: "https://x/face.jpg", position: { top: 200, left: 60 }, size: 300, ringColor: "#ff0000", ringWidth: 6 }] }, C);
    expect(html).toContain("https://x/face.jpg");
    expect(html).toContain("border-radius:50%");
    expect(html).toContain("border:6px solid #ff0000");
  });
  it("renders multiple insets (Hema ×2)", () => {
    const html = renderCircularInset({ items: [
      { imageUrl: "https://x/a.jpg", position: { top: 100, left: 60 }, size: 240 },
      { imageUrl: "https://x/b.jpg", position: { top: 100, left: 360 }, size: 240 },
    ] }, C);
    expect((html.match(/border-radius:50%/g) || []).length).toBe(2);
  });
  it("skips an item with a malicious url and keeps valid ones", () => {
    const html = renderCircularInset({ items: [
      { imageUrl: `https://x/a.jpg");}</style>`, position: { top: 0, left: 0 }, size: 100 },
      { imageUrl: "https://x/ok.jpg", position: { top: 0, left: 120 }, size: 100 },
    ] }, C);
    expect(html).not.toContain(`https://x/a.jpg");}</style>`);
    expect(html).toContain("https://x/ok.jpg");
  });
  it("emits nothing when no items", () => {
    expect(renderCircularInset({ items: [] }, C)).toBe("");
  });
});

import { renderLabelChip, type LabelChipBlockProps } from "../tools/card-engine";

describe("renderLabelChip", () => {
  it("renders a positioned pill with bg + highlight markup", () => {
    const html = renderLabelChip({ pills: [{ text: "[[History Created|#ffd700|box]]", bg: "#000000", textColor: "#ffffff", position: { top: 80, left: 60 }, shape: "pill" }] }, C);
    expect(html).toContain("background:#000000");
    expect(html).toContain("background:#ffd700"); // the box-mode span
    expect(html).toContain("History Created");
  });
  it("renders multiple chips with mixed colors", () => {
    const html = renderLabelChip({ pills: [
      { text: "Rejected", bg: "#e11d48" },
      { text: "Approved", bg: "#16a34a" },
    ] }, C);
    expect(html).toContain("#e11d48");
    expect(html).toContain("#16a34a");
  });
  it("applies a per-pill bgOpacity overriding the global default", () => {
    const html = renderLabelChip({ pills: [{ text: "x", bg: "#112233", bgOpacity: 40 }] }, { ...C, bgOpacity: 100 });
    expect(html).toContain("opacity:0.4");
  });
  it("rejects a malicious pill bg (injection)", () => {
    const html = renderLabelChip({ pills: [{ text: "x", bg: `#fff" onload=alert(1)` }] }, C);
    expect(html).not.toContain("onload=alert(1)");
  });
  it("respects the bar shape", () => {
    const html = renderLabelChip({ pills: [{ text: "Bar", shape: "bar" }] }, C);
    expect(html).toContain("border-radius:8px");
  });
  it("emits nothing when no pills", () => {
    expect(renderLabelChip({ pills: [] }, C)).toBe("");
  });
});

import { renderTweetHeader, type TweetHeaderBlockProps } from "../tools/card-engine";

describe("renderTweetHeader", () => {
  it("renders name + @handle + verified tick", () => {
    const html = renderTweetHeader({ displayName: "Moviefied", handle: "moviefied", verified: true, logoUrl: "https://x/av.png" }, C);
    expect(html).toContain("Moviefied");
    expect(html).toContain("@moviefied");
    expect(html).toContain("verified-tick");
    expect(html).toContain("https://x/av.png");
  });
  it("omits the tick when not verified", () => {
    const html = renderTweetHeader({ displayName: "Brand", handle: "brand" }, C);
    expect(html).not.toContain("verified-tick");
  });
  it("escapes the display name and handle", () => {
    const html = renderTweetHeader({ displayName: `<b>X</b>`, handle: `y"z` }, C);
    expect(html).toContain("&lt;b&gt;X");
    expect(html).toContain("@y&quot;z");
  });
  it("uses a sanitized verified color", () => {
    const html = renderTweetHeader({ displayName: "B", handle: "b", verified: true, verifiedColor: `#fff"onload=x` }, C);
    expect(html).not.toContain("onload=x");
  });
});

import { renderCaptionStack, type CaptionStackBlockProps } from "../tools/card-engine";

describe("renderCaptionStack", () => {
  it("renders a single white pill bottom-anchored", () => {
    const html = renderCaptionStack({ pills: [{ text: "Breaking news today" }] }, C);
    expect(html).toContain("Breaking news today");
    expect(html).toContain("caption-stack");
  });
  it("renders multiple pills (white + red)", () => {
    const html = renderCaptionStack({ pills: [
      { text: "First", bg: "#ffffff", textColor: "#000000" },
      { text: "Second", bg: "#e11d48", textColor: "#ffffff" },
    ] }, C);
    expect(html).toContain("#ffffff");
    expect(html).toContain("#e11d48");
  });
  it("applies the global bgOpacity to a pill (opacity slider)", () => {
    const html = renderCaptionStack({ pills: [{ text: "x" }] }, { ...C, bgOpacity: 60 });
    expect(html).toContain("opacity:0.6");
  });
  it("a per-pill bgOpacity overrides the global", () => {
    const html = renderCaptionStack({ pills: [{ text: "x", bgOpacity: 25 }] }, { ...C, bgOpacity: 100 });
    expect(html).toContain("opacity:0.25");
  });
  it("renders a whitelisted trailing emoji, drops a malicious one", () => {
    const ok = renderCaptionStack({ pills: [{ text: "Alert", emoji: "🚨" }] }, C);
    expect(ok).toContain("🚨");
    const bad = renderCaptionStack({ pills: [{ text: "x", emoji: `"><script>` }] }, C);
    expect(bad).not.toContain("<script>");
  });
  it("honors per-pill center alignment", () => {
    const html = renderCaptionStack({ pills: [{ text: "x", align: "center" }] }, C);
    expect(html).toContain("text-align:center");
  });
  it("renders multi-span highlight markup inside a pill", () => {
    const html = renderCaptionStack({ pills: [{ text: "[[A|#111]] vs [[B|#222|box]]" }] }, C);
    expect(html).toContain("color:#111");
    expect(html).toContain("background:#222");
  });
  it("rejects a malicious pill bg color", () => {
    const html = renderCaptionStack({ pills: [{ text: "x", bg: `#fff" onload=alert(1)` }] }, C);
    expect(html).not.toContain("onload=alert(1)");
  });
  it("emits nothing when no pills", () => {
    expect(renderCaptionStack({ pills: [] }, C)).toBe("");
  });
});

import { renderStatCards, type StatCardsBlockProps } from "../tools/card-engine";

describe("renderStatCards", () => {
  it("renders label + value callout boxes (SpaceX IPO)", () => {
    const html = renderStatCards({ cards: [{ label: "IPO SIZE", value: "$75 BILLION", bg: "#1d4ed8" }] }, C);
    expect(html).toContain("IPO SIZE");
    expect(html).toContain("$75 BILLION");
    expect(html).toContain("#1d4ed8");
  });
  it("renders multiple cards and escapes label/value", () => {
    const html = renderStatCards({ cards: [
      { label: "<A>", value: "1" },
      { label: "B", value: `"2"` },
    ] }, C);
    expect(html).toContain("&lt;A&gt;");
    expect(html).toContain("&quot;2&quot;");
  });
  it("rejects a malicious card bg", () => {
    const html = renderStatCards({ cards: [{ label: "x", value: "y", bg: `#fff" onload=x` }] }, C);
    expect(html).not.toContain("onload=x");
  });
  it("emits nothing with no cards", () => {
    expect(renderStatCards({ cards: [] }, C)).toBe("");
  });
});
