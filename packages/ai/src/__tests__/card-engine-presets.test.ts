import { describe, it, expect } from "vitest";
import { preset, renderCard, type PresetId, type StyleControls } from "../tools/card-engine";

const ALL: PresetId[] = [
  "news_caption", "news_inset", "infographic_stats", "marketing_minimal",
  "tweet_card", "photo_grid", "title_cover", "listicle_body",
];

describe("presets", () => {
  it("every preset returns a renderable CardSpec", () => {
    for (const id of ALL) {
      const spec = preset(id);
      expect(spec.canvas).toEqual({ w: 1080, h: 1350 });
      expect(Array.isArray(spec.blocks)).toBe(true);
      const html = renderCard(spec);
      expect(html).toContain("<!DOCTYPE html>");
    }
  });

  it("news_caption enables background + logo + captionStack", () => {
    const spec = preset("news_caption");
    const kinds = spec.blocks.map((b) => b.kind);
    expect(kinds).toContain("background");
    expect(kinds).toContain("logo");
    expect(kinds).toContain("captionStack");
  });

  it("news_inset adds a circularInset block", () => {
    expect(preset("news_inset").blocks.map((b) => b.kind)).toContain("circularInset");
  });

  it("infographic_stats adds a statCards block", () => {
    expect(preset("infographic_stats").blocks.map((b) => b.kind)).toContain("statCards");
  });

  it("tweet_card uses a tweetHeader + bodyText", () => {
    const kinds = preset("tweet_card").blocks.map((b) => b.kind);
    expect(kinds).toContain("tweetHeader");
    expect(kinds).toContain("bodyText");
  });

  it("marketing_minimal uses topTextBottomPhoto + carouselChrome", () => {
    const spec = preset("marketing_minimal");
    const bg = spec.blocks.find((b) => b.kind === "background");
    expect(bg && bg.kind === "background" && bg.props.mode).toBe("topTextBottomPhoto");
    expect(spec.blocks.map((b) => b.kind)).toContain("carouselChrome");
  });

  it("photo_grid uses a photoGrid background", () => {
    const spec = preset("photo_grid");
    const bg = spec.blocks.find((b) => b.kind === "background");
    expect(bg && bg.kind === "background" && bg.props.mode).toBe("photoGrid");
  });

  it("listicle_body uses bodyText + footer", () => {
    const kinds = preset("listicle_body").blocks.map((b) => b.kind);
    expect(kinds).toContain("bodyText");
    expect(kinds).toContain("footer");
  });

  it("applies StyleControls overrides", () => {
    const overrides: Partial<StyleControls> = { brandColor: "#abcabc", theme: "dark" };
    const spec = preset("news_caption", overrides);
    expect(spec.controls.brandColor).toBe("#abcabc");
    expect(spec.controls.theme).toBe("dark");
  });
});
