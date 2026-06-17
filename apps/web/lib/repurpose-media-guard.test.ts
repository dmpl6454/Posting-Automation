import { describe, expect, it } from "vitest";
import { shouldBlockMediaLessPublish } from "./repurpose-media-guard";

/**
 * R4 defense-in-depth: when a static-IMAGE render silently produced no media
 * (the backend bug this guards alongside), a user could still click "Create
 * Drafts" → a media-less draft → Instagram/Facebook publish fails with
 * "Instagram requires an image; none attached." This guard blocks that locally.
 *
 * Block iff ALL of:
 *   - mediaIds is empty, AND
 *   - the format is an IMAGE format (NOT a video format — videos deliver media
 *     asynchronously and legitimately have empty mediaIds at draft time), AND
 *   - at least one selected channel targets a media-required platform (IG/FB).
 */
describe("shouldBlockMediaLessPublish", () => {
  it("BLOCKS a media-less static image post targeting Instagram", () => {
    expect(shouldBlockMediaLessPublish([], "static", ["INSTAGRAM"])).toBe(true);
  });

  it("BLOCKS a media-less static image post targeting Facebook", () => {
    expect(shouldBlockMediaLessPublish([], "static", ["FACEBOOK"])).toBe(true);
  });

  it("BLOCKS a media-less carousel targeting Instagram", () => {
    expect(shouldBlockMediaLessPublish([], "carousel", ["INSTAGRAM"])).toBe(true);
  });

  it("BLOCKS when ONE of several platforms is media-required", () => {
    expect(
      shouldBlockMediaLessPublish([], "static", ["TWITTER", "INSTAGRAM"]),
    ).toBe(true);
  });

  it("does NOT block when media IS attached", () => {
    expect(shouldBlockMediaLessPublish(["m1"], "static", ["INSTAGRAM"])).toBe(false);
  });

  it("does NOT block a video format (reel) even with empty media — video is async", () => {
    expect(shouldBlockMediaLessPublish([], "reel", ["INSTAGRAM"])).toBe(false);
  });

  it("does NOT block ai_video with empty media (videoPending)", () => {
    expect(shouldBlockMediaLessPublish([], "ai_video", ["INSTAGRAM"])).toBe(false);
  });

  it("does NOT block seedance_video with empty media (videoPending)", () => {
    expect(shouldBlockMediaLessPublish([], "seedance_video", ["INSTAGRAM"])).toBe(false);
  });

  it("does NOT block when no media-required platform is targeted (e.g. Twitter only)", () => {
    expect(shouldBlockMediaLessPublish([], "static", ["TWITTER"])).toBe(false);
  });

  it("does NOT block when no channels are selected (Save as Draft)", () => {
    expect(shouldBlockMediaLessPublish([], "static", [])).toBe(false);
  });

  it("is case-insensitive on platform names", () => {
    expect(shouldBlockMediaLessPublish([], "static", ["instagram"])).toBe(true);
    expect(shouldBlockMediaLessPublish([], "static", ["facebook"])).toBe(true);
  });

  it("tolerates undefined platform entries (unresolved channel id)", () => {
    expect(
      shouldBlockMediaLessPublish([], "static", [undefined, "INSTAGRAM"]),
    ).toBe(true);
    expect(shouldBlockMediaLessPublish([], "static", [undefined])).toBe(false);
  });
});
