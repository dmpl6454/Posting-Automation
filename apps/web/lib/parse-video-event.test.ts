import { describe, it, expect } from "vitest";
import { parseVideoReadyEvent, isVideoErrorEvent, finalizeRunningSteps } from "./parse-video-event";

describe("parseVideoReadyEvent", () => {
  it("parses a valid video_ready step into mediaId/url/format", () => {
    const result = parseVideoReadyEvent({
      step: "video_ready",
      status: "done",
      detail: JSON.stringify({ mediaId: "m1", url: "https://s3/x.mp4", format: "reel" }),
    });
    expect(result).toEqual({ mediaId: "m1", url: "https://s3/x.mp4", format: "reel" });
  });

  it("returns null for a non-video_ready step", () => {
    expect(parseVideoReadyEvent({ step: "some_other_step", detail: "..." })).toBeNull();
  });

  it("returns null (no throw) for malformed JSON detail", () => {
    expect(parseVideoReadyEvent({ step: "video_ready", detail: "not json" })).toBeNull();
  });

  it("returns null when detail is missing", () => {
    expect(parseVideoReadyEvent({ step: "video_ready" })).toBeNull();
  });

  it("returns null when JSON is missing mediaId or url", () => {
    expect(
      parseVideoReadyEvent({ step: "video_ready", detail: JSON.stringify({ format: "reel" }) }),
    ).toBeNull();
    expect(
      parseVideoReadyEvent({ step: "video_ready", detail: JSON.stringify({ mediaId: "m1" }) }),
    ).toBeNull();
  });

  it("defaults format to empty string when absent but mediaId+url present", () => {
    const result = parseVideoReadyEvent({
      step: "video_ready",
      detail: JSON.stringify({ mediaId: "m1", url: "https://s3/x.mp4" }),
    });
    expect(result).toEqual({ mediaId: "m1", url: "https://s3/x.mp4", format: "" });
  });
});

describe("isVideoErrorEvent", () => {
  it("returns true for a video_error step", () => {
    expect(isVideoErrorEvent({ step: "video_error" })).toBe(true);
  });

  it("returns false for a video_ready step", () => {
    expect(isVideoErrorEvent({ step: "video_ready" })).toBe(false);
  });
});

describe("finalizeRunningSteps", () => {
  it("flips every running step to done, leaving others untouched", () => {
    const steps = [
      { step: "a", status: "running" as const },
      { step: "b", status: "done" as const },
      { step: "c", status: "running" as const },
    ];
    const result = finalizeRunningSteps(steps, "done");
    expect(result.map((s) => s.status)).toEqual(["done", "done", "done"]);
  });

  it("flips running steps to error when given error", () => {
    const steps = [
      { step: "a", status: "running" as const },
      { step: "b", status: "skipped" as const },
    ];
    const result = finalizeRunningSteps(steps, "error");
    expect(result.map((s) => s.status)).toEqual(["error", "skipped"]);
  });

  it("does not mutate the input array and preserves other fields", () => {
    const steps = [{ step: "a", status: "running" as const, detail: "x" }];
    const result = finalizeRunningSteps(steps, "done");
    expect(steps[0]!.status).toBe("running"); // original untouched
    expect(result[0]).toEqual({ step: "a", status: "done", detail: "x" });
  });

  it("leaves already-done and error steps unchanged", () => {
    const steps = [
      { step: "a", status: "done" as const },
      { step: "b", status: "error" as const },
    ];
    const result = finalizeRunningSteps(steps, "done");
    expect(result).toEqual(steps);
  });
});
