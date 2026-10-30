import { describe, it, expect } from "vitest";
import { videoLengthStatus, probedDurationFor } from "./video-length-probe";

/**
 * Compose measures the first attached video once (one detached <video>). The
 * result is tied to the URL it was measured from, so nothing ever judges video
 * B by video A's length (2026-10-28 review: the old probe never reset).
 */
describe("videoLengthStatus", () => {
  it("is 'none' without a video", () => {
    expect(videoLengthStatus(null, null)).toBe("none");
    expect(videoLengthStatus(null, { url: "blob:a", status: "done" })).toBe("none");
  });
  it("is 'pending' until THIS url has been measured", () => {
    expect(videoLengthStatus("blob:a", null)).toBe("pending");
  });
  it("a result for ANOTHER url is not this video's result (the swap case)", () => {
    expect(videoLengthStatus("blob:b", { url: "blob:a", status: "done" })).toBe("pending");
    expect(videoLengthStatus("blob:b", { url: "blob:a", status: "failed" })).toBe("pending");
  });
  it("reports the outcome recorded for this url", () => {
    expect(videoLengthStatus("blob:a", { url: "blob:a", status: "done" })).toBe("done");
    expect(videoLengthStatus("blob:a", { url: "blob:a", status: "failed" })).toBe("failed");
  });
});

describe("probedDurationFor", () => {
  it("returns the duration only when it was measured from this url", () => {
    expect(probedDurationFor("blob:a", { url: "blob:a", status: "done" }, 42)).toBe(42);
  });
  it("never returns a stale or unknown duration", () => {
    expect(probedDurationFor("blob:b", { url: "blob:a", status: "done" }, 42)).toBeNull();
    expect(probedDurationFor("blob:a", { url: "blob:a", status: "failed" }, 42)).toBeNull();
    expect(probedDurationFor("blob:a", null, 42)).toBeNull();
    expect(probedDurationFor(null, null, 42)).toBeNull();
  });
  it("rejects a non-finite or non-positive duration", () => {
    for (const d of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(probedDurationFor("blob:a", { url: "blob:a", status: "done" }, d)).toBeNull();
    }
  });
});
