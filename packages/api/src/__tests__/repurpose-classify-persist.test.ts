import { describe, it, expect } from "vitest";
import {
  buildSavedStyleName,
  shouldPersistReference,
  presetToCreativeStyle,
  isPhotoCardPreset,
} from "../routers/repurpose.router";

describe("saved-style persistence helpers", () => {
  it("buildSavedStyleName derives a readable name from a hint preset + date", () => {
    const name = buildSavedStyleName("news_inset", new Date("2026-06-13T00:00:00Z"));
    expect(name).toMatch(/News Inset/);
    expect(name).toMatch(/2026-06-13/);
  });

  it("buildSavedStyleName falls back to 'Saved style' for an unknown preset", () => {
    expect(buildSavedStyleName(undefined, new Date("2026-06-13T00:00:00Z"))).toMatch(/Saved style/);
  });

  it("shouldPersistReference true only with a stored media id AND a confident hint", () => {
    expect(shouldPersistReference("media-1", { confidence: 0.8 } as any)).toBe(true);
    expect(shouldPersistReference("media-1", { confidence: 0.2 } as any)).toBe(false);
    expect(shouldPersistReference(undefined, { confidence: 0.9 } as any)).toBe(false);
    expect(shouldPersistReference("media-1", null)).toBe(false);
  });
});

describe("reference detection → render mapping (D)", () => {
  it("presetToCreativeStyle maps each preset to one of the 4 renderable styles", () => {
    const RENDERABLE = ["premium_editorial", "hook_bars", "tweet_card", "bold_typographic"];
    for (const p of [
      "news_caption", "news_inset", "infographic_stats", "marketing_minimal",
      "tweet_card", "photo_grid", "title_cover", "listicle_body",
    ]) {
      expect(RENDERABLE).toContain(presetToCreativeStyle(p));
    }
  });

  it("presetToCreativeStyle picks the closest style per preset", () => {
    expect(presetToCreativeStyle("tweet_card")).toBe("tweet_card");
    expect(presetToCreativeStyle("news_inset")).toBe("hook_bars");
    expect(presetToCreativeStyle("marketing_minimal")).toBe("bold_typographic");
    expect(presetToCreativeStyle("infographic_stats")).toBe("bold_typographic");
    expect(presetToCreativeStyle("news_caption")).toBe("premium_editorial");
    expect(presetToCreativeStyle("title_cover")).toBe("premium_editorial");
    // Unknown / future presets degrade to the photo-led default, never crash.
    expect(presetToCreativeStyle("something_new")).toBe("premium_editorial");
  });

  it("isPhotoCardPreset is true only for photo-led layouts (E real-photo preference)", () => {
    expect(isPhotoCardPreset("news_caption")).toBe(true);
    expect(isPhotoCardPreset("title_cover")).toBe(true);
    expect(isPhotoCardPreset("photo_grid")).toBe(true);
    expect(isPhotoCardPreset("news_inset")).toBe(true);
    expect(isPhotoCardPreset("tweet_card")).toBe(false);
    expect(isPhotoCardPreset("infographic_stats")).toBe(false);
    expect(isPhotoCardPreset("marketing_minimal")).toBe(false);
  });
});
