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
  it("positions itself above the background so it is not occluded", () => {
    // Regression: a static (non-positioned) header is painted UNDER the absolute
    // background block and vanishes. The wrapper must be positioned + z-indexed.
    const html = renderTweetHeader({ displayName: "B", handle: "b" }, C);
    expect(html).toMatch(/class="tweet-head"[^>]*position:absolute/);
    expect(html).toMatch(/class="tweet-head"[^>]*z-index:/);
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
  // Round 19 FIX 3 — blank-headline-box bug. A pill with empty/whitespace text must
  // NOT render an empty box (the "box" variant paints a solid background even with
  // no text → a blank white/dark rectangle some refs hit on first generation).
  it("skips an empty-text box pill (no blank background box)", () => {
    const html = renderCaptionStack({ pills: [{ text: "" }] }, C);
    expect(html).not.toContain("caption-pill");
  });
  it("skips a whitespace-only box pill", () => {
    const html = renderCaptionStack({ pills: [{ text: "   " }] }, C);
    expect(html).not.toContain("caption-pill");
  });
  it("skips an empty-text plain pill (no stray empty headline)", () => {
    const html = renderCaptionStack({ pills: [{ text: "  ", variant: "plain" }] }, C);
    expect(html).not.toContain("caption-plain");
  });
  it("still renders a non-empty pill but skips an adjacent empty one", () => {
    const html = renderCaptionStack({ pills: [{ text: "" }, { text: "Real headline" }] }, C);
    expect(html).toContain("Real headline");
    // exactly one caption-pill div, not two
    expect(html.match(/caption-pill/g)?.length ?? 0).toBe(1);
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

import { renderBodyText, type BodyTextBlockProps } from "../tools/card-engine";

describe("renderBodyText", () => {
  it("renders title + meta rows + description", () => {
    const html = renderBodyText({
      title: "Kalki 2898",
      meta: [{ label: "Starring", value: "Prabhas" }, { label: "Genre", value: "Sci-fi" }],
      description: "A dystopian epic set in the future.",
    }, C);
    expect(html).toContain("Kalki 2898");
    expect(html).toContain("Starring");
    expect(html).toContain("Prabhas");
    expect(html).toContain("dystopian epic");
  });
  it("escapes all fields", () => {
    const html = renderBodyText({ title: "<x>", description: `"d"`, meta: [{ label: "<l>", value: "<v>" }] }, C);
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("&quot;d&quot;");
    expect(html).toContain("&lt;l&gt;");
  });
  it("renders with description only (no title/meta)", () => {
    const html = renderBodyText({ description: "Just a paragraph." }, C);
    expect(html).toContain("Just a paragraph.");
  });
  it("uses a sanitized text color override", () => {
    const html = renderBodyText({ description: "x", textColor: `#fff" onload=x` }, C);
    expect(html).not.toContain("onload=x");
  });
});

import { renderFooter, type FooterBlockProps } from "../tools/card-engine";

describe("renderFooter", () => {
  it("renders a follow line", () => {
    const html = renderFooter({ text: "Follow @moviefied for more" }, C);
    expect(html).toContain("Follow @moviefied for more");
    expect(html).toContain("card-footer");
  });
  it("escapes the text", () => {
    const html = renderFooter({ text: `<b>X</b>` }, C);
    expect(html).toContain("&lt;b&gt;X");
  });
  it("uses a sanitized color override", () => {
    const html = renderFooter({ text: "x", textColor: `#fff" onload=x` }, C);
    expect(html).not.toContain("onload=x");
  });
});

import { renderCarouselChrome, type CarouselChromeBlockProps } from "../tools/card-engine";

describe("renderCarouselChrome", () => {
  it("renders a progress bar reflecting current/total", () => {
    const html = renderCarouselChrome({ totalSlides: 5, currentSlide: 2, progressBar: { color: "#7c8cff", height: 6 } }, C);
    expect(html).toContain("#7c8cff");
    // slide 2 of 5 (0-indexed) → 60% width
    expect(html).toContain("width:60%");
  });
  it("renders page dots when requested", () => {
    const html = renderCarouselChrome({ totalSlides: 3, currentSlide: 0, pageDots: true }, C);
    expect((html.match(/page-dot/g) || []).length).toBe(3);
  });
  it("renders a nav-arrow hint when requested", () => {
    const html = renderCarouselChrome({ totalSlides: 3, currentSlide: 0, navArrowHint: true }, C);
    expect(html).toContain("nav-arrow");
  });
  it("rejects a malicious progress color", () => {
    const html = renderCarouselChrome({ totalSlides: 2, currentSlide: 0, progressBar: { color: `#fff" onload=x` } }, C);
    expect(html).not.toContain("onload=x");
  });
});

import { renderCtaCard, type CtaCardBlockProps } from "../tools/card-engine";

describe("renderCtaCard", () => {
  it("renders headline + follow button on a branded bg", () => {
    const html = renderCtaCard({ headline: "Follow Us", buttonText: "Follow", bg: "#7c8cff" }, C);
    expect(html).toContain("Follow Us");
    expect(html).toContain("#7c8cff");
    expect(html).toContain(">Follow<");
  });
  it("renders an optional phone mockup image", () => {
    const html = renderCtaCard({ headline: "Follow Us", phoneAssetUrl: "https://x/phone.png" }, C);
    expect(html).toContain("https://x/phone.png");
  });
  it("escapes headline + subheading", () => {
    const html = renderCtaCard({ headline: `<b>F</b>`, subheading: `"s"` }, C);
    expect(html).toContain("&lt;b&gt;F");
    expect(html).toContain("&quot;s&quot;");
  });
  it("rejects a malicious bg and a malicious phone url", () => {
    const html = renderCtaCard({ headline: "x", bg: `#fff" onload=x`, phoneAssetUrl: `https://x/p.png");}</style>` }, C);
    expect(html).not.toContain("onload=x");
    expect(html).not.toContain(`https://x/p.png");}</style>`);
  });
});

// ── Reference-faithful extensions (2026-06-15) ──────────────────────────────
describe("captionStack — plain variant + brand label (moviefied headline)", () => {
  it("plain variant renders boxless huge bold text (no pill box), with highlight", () => {
    const html = renderCaptionStack(
      { pills: [{ text: "Five IAF personnel [[killed]] in crash", variant: "plain", textColor: "#ffffff" }] },
      { ...C, theme: "dark", highlightColor: "#ff7f50" },
    );
    expect(html).toContain("caption-plain");
    expect(html).toContain("font-weight:900");
    // boxless: no pill box-shadow / radius box
    expect(html).not.toContain("caption-pill");
    // highlight still applies
    expect(html).toContain("color:#ff7f50");
    // dark theme → legibility shadow
    expect(html).toContain("text-shadow:");
  });

  it("light-theme plain variant uses dark text and no shadow", () => {
    const html = renderCaptionStack(
      { pills: [{ text: "Headline", variant: "plain" }] },
      { ...C, theme: "light" },
    );
    expect(html).toContain("caption-plain");
    expect(html).not.toContain("text-shadow:");
  });

  it("renders a brand label/wordmark with an accent underline above the headline (underline:true)", () => {
    const html = renderCaptionStack(
      { label: { text: "Moviefied", italic: true, underline: true }, pills: [{ text: "Big news", variant: "plain" }] },
      { ...C, brandColor: "#ff7f50" },
    );
    expect(html).toContain("caption-label");
    expect(html).toContain("Moviefied");
    expect(html).toContain("font-style:italic");
    expect(html).toContain("background:#ff7f50"); // the underline rule
  });

  // ── Round 17: per-reference underline (default OFF) + label color ──────────────
  it("Round 17 FIX 2: omits the underline bar when underline is unset (default off)", () => {
    const html = renderCaptionStack(
      { label: { text: "MAM", italic: true }, pills: [{ text: "Big news", variant: "plain" }] },
      { ...C, brandColor: "#ff7f50" },
    );
    expect(html).toContain("caption-label");
    expect(html).toContain("MAM");
    // no underline div → the accent background rule is not emitted for the label
    expect(html).not.toContain("background:#ff7f50");
  });

  it("Round 17 FIX 2: omits the underline bar when underline:false", () => {
    const html = renderCaptionStack(
      { label: { text: "MAM", italic: true, underline: false }, pills: [{ text: "x", variant: "plain" }] },
      { ...C, brandColor: "#ff7f50" },
    );
    expect(html).not.toContain("background:#ff7f50");
  });

  it("Round 17 FIX 3: label color defaults to the theme textColor when unset", () => {
    const html = renderCaptionStack(
      { label: { text: "MAM" }, pills: [{ text: "x", variant: "plain" }] },
      { ...C, theme: "dark" },
    );
    // dark theme textColor is #ffffff
    expect(html).toMatch(/caption-label[^>]*color:#ffffff/);
  });

  it("Round 17 FIX 3: explicit label color wins over the theme textColor", () => {
    const html = renderCaptionStack(
      { label: { text: "MAM", color: "#123abc" }, pills: [{ text: "x", variant: "plain" }] },
      { ...C, theme: "light" }, // light theme textColor is #0f1419, but explicit wins
    );
    expect(html).toMatch(/caption-label[^>]*color:#123abc/);
  });

  it("Round 17 FIX 3: an invalid label color falls back through safeColor (no CSS injection)", () => {
    const html = renderCaptionStack(
      { label: { text: "MAM", color: "red;}</style>" }, pills: [{ text: "x", variant: "plain" }] },
      C,
    );
    expect(html).not.toContain("red;}");
    expect(html).not.toContain("</style>");
  });

  it("escapes a malicious brand label (no injection)", () => {
    const html = renderCaptionStack(
      { label: { text: `<img src=x onerror=alert(1)>` }, pills: [{ text: "x", variant: "plain" }] },
      C,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("box variant is unchanged (still a boxed pill)", () => {
    const html = renderCaptionStack({ pills: [{ text: "Boxed" }] }, C);
    expect(html).toContain("caption-pill");
    expect(html).not.toContain("caption-plain");
  });
});

describe("renderBackground — brand scrim (photo→brand blend)", () => {
  it("scrimMode 'brand' bleeds the photo into the brand color at the bottom", () => {
    const html = renderBackground(
      { mode: "photo", imageUrl: "https://cdn.x/p.jpg", scrimMode: "brand" },
      { ...C, brandColor: "#ff7f50" },
    );
    expect(html).toContain("https://cdn.x/p.jpg");
    expect(html).toContain("#ff7f50"); // brand gradient scrim
  });
  it("scrimMode 'none' omits the scrim", () => {
    const html = renderBackground(
      { mode: "photo", imageUrl: "https://cdn.x/p.jpg", scrimMode: "none" },
      C,
    );
    expect(html).toContain("https://cdn.x/p.jpg");
    expect(html).not.toContain('class="scrim"');
  });
  it("default scrim (no scrimMode) is the dark legibility scrim — no regression", () => {
    const html = renderBackground({ mode: "photo", imageUrl: "https://cdn.x/p.jpg" }, C);
    expect(html).toContain('class="scrim"');
  });
});
