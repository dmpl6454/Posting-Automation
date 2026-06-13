import { describe, it, expect } from "vitest";
import { renderCard, CANVAS, DEFAULT_CONTROLS, type CardSpec } from "../tools/card-engine";
import { buildCardHtmlForPuppeteer } from "../tools/news-image-generator";

const spec = (blocks: CardSpec["blocks"], controls = DEFAULT_CONTROLS): CardSpec => ({
  canvas: CANVAS, blocks, controls,
});

describe("renderCard", () => {
  it("emits a full HTML doc at 1080x1350", () => {
    const html = renderCard(spec([{ kind: "footer", props: { text: "Follow @x" } }]));
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("width:1080px");
    expect(html).toContain("height:1350px");
    expect(html).toContain("@import url('https://fonts.googleapis.com");
  });

  it("renders blocks in order (background before caption)", () => {
    const html = renderCard(spec([
      { kind: "background", props: { mode: "photo", imageUrl: "https://x/p.jpg" } },
      { kind: "captionStack", props: { pills: [{ text: "Hello" }] } },
    ]));
    expect(html.indexOf("https://x/p.jpg")).toBeLessThan(html.indexOf("Hello"));
  });

  it("omits a block with missing inputs (no broken slot)", () => {
    const html = renderCard(spec([
      { kind: "circularInset", props: { items: [] } },
      { kind: "footer", props: { text: "kept" } },
    ]));
    expect(html).toContain("kept");
    expect(html).not.toContain("border-radius:50%");
  });

  it("honors the dark theme (no forced white on a light bg)", () => {
    const html = renderCard(spec(
      [{ kind: "bodyText", props: { description: "x" } }],
      { ...DEFAULT_CONTROLS, theme: "light" },
    ));
    // light theme body text is dark, not white
    expect(html).toContain("#0f1419");
  });

  it("applies the chosen font stack from controls", () => {
    const html = renderCard(spec(
      [{ kind: "footer", props: { text: "x" } }],
      { ...DEFAULT_CONTROLS, fontFamily: "serif_display" },
    ));
    expect(html).toContain("Playfair Display");
  });

  it("renders a composite spec no preset uses (proves composability)", () => {
    const html = renderCard(spec([
      { kind: "background", props: { mode: "gradient" } },
      { kind: "logo", props: { logos: [{ kind: "wordmark", text: "DS", anchor: "tl", size: 8, opacity: 100 }] } },
      { kind: "tweetHeader", props: { displayName: "X", handle: "x", verified: true } },
      { kind: "statCards", props: { cards: [{ label: "L", value: "V" }] } },
      { kind: "captionStack", props: { pills: [{ text: "C" }] } },
    ]));
    expect(html).toContain("DS");
    expect(html).toContain("verified-tick");
    expect(html).toContain("L");
    expect(html).toContain("C");
  });
});

describe("buildCardHtmlForPuppeteer", () => {
  it("returns a renderCard HTML doc for a CardSpec (pure, no browser)", () => {
    const html = buildCardHtmlForPuppeteer(spec([{ kind: "footer", props: { text: "Follow @x" } }]));
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Follow @x");
    expect(html).toContain("width:1080px");
  });
});
