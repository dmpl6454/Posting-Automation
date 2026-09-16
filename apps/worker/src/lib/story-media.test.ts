import { describe, it, expect } from "vitest";
import { decideStoryImageAction, storyFitKeyFor, STORY_FIT_VERSION } from "./story-media";

describe("decideStoryImageAction", () => {
  const sq = { width: 1080, height: 1080 };
  const story = { width: 1080, height: 1920 };

  it("renders anything that is not 9:16 — the shapes that crop on a phone", () => {
    expect(decideStoryImageAction({ dimensions: { width: 1080, height: 1350 }, format: "jpeg", platform: "INSTAGRAM" })).toBe("render");
    expect(decideStoryImageAction({ dimensions: sq, format: "jpeg", platform: "FACEBOOK" })).toBe("render");
  });

  it("passes an already-9:16 JPEG straight through, so a correct story publishes byte-identically", () => {
    expect(decideStoryImageAction({ dimensions: story, format: "jpeg", platform: "INSTAGRAM" })).toBe("passthrough");
    expect(decideStoryImageAction({ dimensions: story, format: "jpg", platform: "FACEBOOK" })).toBe("passthrough");
  });

  it("converts a 9:16 WebP/PNG for INSTAGRAM — Meta accepts JPEG only there", () => {
    expect(decideStoryImageAction({ dimensions: story, format: "webp", platform: "INSTAGRAM" })).toBe("render");
    expect(decideStoryImageAction({ dimensions: story, format: "png", platform: "INSTAGRAM" })).toBe("render");
  });

  it("leaves a 9:16 PNG alone for FACEBOOK, whose photo stories accept it", () => {
    expect(decideStoryImageAction({ dimensions: story, format: "png", platform: "FACEBOOK" })).toBe("passthrough");
  });

  it("never renders on an unmeasurable source — guessing is worse than publishing as-is", () => {
    expect(decideStoryImageAction({ dimensions: null, format: "webp", platform: "INSTAGRAM" })).toBe("passthrough");
    expect(decideStoryImageAction({ dimensions: null, format: null, platform: "FACEBOOK" })).toBe("passthrough");
  });
});

describe("storyFitKeyFor", () => {
  it("is deterministic, so one render serves the whole fan-out and every retry", () => {
    expect(storyFitKeyFor("org_1", "med_1")).toBe(storyFitKeyFor("org_1", "med_1"));
    expect(storyFitKeyFor("org_1", "med_1")).toContain(`1080x1920-${STORY_FIT_VERSION}`);
  });

  it("keeps a .jpg extension — the provider sniffs video by URL extension FIRST", () => {
    expect(storyFitKeyFor("org_1", "med_1").endsWith(".jpg")).toBe(true);
  });

  it("scopes objects per organisation and per media row", () => {
    expect(storyFitKeyFor("org_1", "med_1")).not.toBe(storyFitKeyFor("org_2", "med_1"));
    expect(storyFitKeyFor("org_1", "med_1")).not.toBe(storyFitKeyFor("org_1", "med_2"));
    expect(storyFitKeyFor("org_1", "med_1").startsWith("storyfit/org_1/")).toBe(true);
  });
});
