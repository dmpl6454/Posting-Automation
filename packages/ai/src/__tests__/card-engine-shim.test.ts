import { describe, it, expect } from "vitest";
import { legacyStyleToCardSpec, renderCard, DEFAULT_CONTROLS } from "../tools/card-engine";

const ctl = { ...DEFAULT_CONTROLS, brandColor: "#e11d48" };

describe("legacyStyleToCardSpec", () => {
  it("maps premium_editorial → news_caption (single caption pill)", () => {
    const spec = legacyStyleToCardSpec(
      { style: "premium_editorial", headline: "Krrish 4 Budget Debunked", channelName: "Moviefied" },
      ctl,
    );
    const kinds = spec.blocks.map((b) => b.kind);
    expect(kinds).toContain("background");
    expect(kinds).toContain("captionStack");
    const html = renderCard(spec);
    expect(html).toContain("Krrish 4 Budget Debunked");
  });

  it("maps hook_bars → news_caption with TWO pills (hook + headline), deduped", () => {
    const spec = legacyStyleToCardSpec(
      { style: "hook_bars", headline: "TMC leader arrested near border", hookLine: "How did this happen?!", channelName: "NewsPage" },
      ctl,
    );
    const cap = spec.blocks.find((b) => b.kind === "captionStack");
    expect(cap && cap.kind === "captionStack" && cap.props.pills.length).toBe(2);
    const html = renderCard(spec);
    expect(html).toContain("How did this happen");
    expect(html).toContain("TMC leader arrested near border");
  });

  it("drops the hook when it duplicates the headline (single pill)", () => {
    const spec = legacyStyleToCardSpec(
      { style: "hook_bars", headline: "TMC leader arrested near border", hookLine: "TMC leader arrested near the border", channelName: "NewsPage" },
      ctl,
    );
    const cap = spec.blocks.find((b) => b.kind === "captionStack");
    expect(cap && cap.kind === "captionStack" && cap.props.pills.length).toBe(1);
  });

  it("maps tweet_card → tweet_card preset with header + body", () => {
    const spec = legacyStyleToCardSpec(
      { style: "tweet_card", headline: "Conrad Fisher back!!!", channelName: "Moviefied", handle: "@moviefied", verified: true },
      ctl,
    );
    const kinds = spec.blocks.map((b) => b.kind);
    expect(kinds).toContain("tweetHeader");
    const html = renderCard(spec);
    expect(html).toContain("Conrad Fisher back");
    expect(html).toContain("verified-tick");
  });

  it("maps bold_typographic → title_cover", () => {
    const spec = legacyStyleToCardSpec(
      { style: "bold_typographic", headline: "Biggest releases", channelName: "Moviefied" },
      ctl,
    );
    const html = renderCard(spec);
    expect(html).toContain("Biggest releases");
  });

  it("forwards a sanitized bgImageUrl into the background block", () => {
    const spec = legacyStyleToCardSpec(
      { style: "premium_editorial", headline: "x", channelName: "B", bgImageUrl: "https://cdn.x/p.jpg" },
      ctl,
    );
    expect(renderCard(spec)).toContain("https://cdn.x/p.jpg");
  });
});
