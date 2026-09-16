import { describe, it, expect } from "vitest";
import {
  buildStoryCanvasFilter,
  STORY_CANVAS_WIDTH,
  STORY_CANVAS_HEIGHT,
} from "./story-render-args";

describe("buildStoryCanvasFilter", () => {
  const f = buildStoryCanvasFilter("[0:v]", "[vfit]");

  it("contains the source — the only crop belongs to the backdrop copy", () => {
    expect(f).toContain(`[stfg]scale=${STORY_CANVAS_WIDTH}:${STORY_CANVAS_HEIGHT}:force_original_aspect_ratio=decrease`);
    expect(f.match(/crop=/g)).toHaveLength(1);
    // Blurred at a fraction of canvas size and scaled back up: a full-resolution
    // gblur measured ~3.2x the filter cost per target, for an identical result.
    expect(f).toContain("[stbg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480");
    expect(f).toContain(`scale=${STORY_CANVAS_WIDTH}:${STORY_CANVAS_HEIGHT}[stbgb]`);
  });

  it("centres the content on the canvas", () => {
    expect(f).toContain("overlay=(W-w)/2:(H-h)/2[vfit]");
  });

  it("blurs and darkens the backdrop", () => {
    expect(f).toContain("gblur=sigma=");
    expect(f).toContain("eq=brightness=-");
  });

  it("reads the label it is given and writes the label the graph expects", () => {
    const g = buildStoryCanvasFilter("[vin]", "[vout]");
    expect(g.startsWith("[vin]split=2")).toBe(true);
    expect(g.endsWith("[vout]")).toBe(true);
  });

  it("uses RUNTIME expressions, never probed pixel counts — rotated phone clips depend on it", () => {
    // A concrete source size must never be baked in: ffmpeg auto-rotates on
    // decode, so probed dimensions describe the pre-rotation frame.
    expect(f).not.toMatch(/\[stfg\]scale=\d+:\d+\[/); // the FOREGROUND never gets a fixed size
    expect(f).toContain("force_original_aspect_ratio");
  });

  it("uses labels that cannot collide with the overlay graph's own labels", () => {
    // video-overlay.ts uses [vlogo], [logo], [vout], [0:v], [1:v].
    for (const reserved of ["[vlogo]", "[logo]", "[vout]", "[1:v]"]) {
      expect(f).not.toContain(reserved);
    }
    expect(f).toContain("[stbg]");
    expect(f).toContain("[stfg]");
  });
});
