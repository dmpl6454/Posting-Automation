import { describe, it, expect } from "vitest";
import { buildVideoReadyDetail, buildVideoErrorDetail } from "./repurpose-video";

describe("buildVideoReadyDetail", () => {
  it("serializes mediaId/url/format as JSON", () => {
    expect(buildVideoReadyDetail("m1", "https://s3/x.mp4", "reel")).toBe(
      JSON.stringify({ mediaId: "m1", url: "https://s3/x.mp4", format: "reel" })
    );
  });

  it("round-trips via JSON.parse", () => {
    const detail = buildVideoReadyDetail("abc", "https://s3/y.mp4", "seedance_video");
    expect(JSON.parse(detail)).toEqual({
      mediaId: "abc",
      url: "https://s3/y.mp4",
      format: "seedance_video",
    });
  });
});

describe("buildVideoErrorDetail", () => {
  it("passes the message through unchanged", () => {
    expect(buildVideoErrorDetail("boom")).toBe("boom");
  });
});
