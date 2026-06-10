import { describe, it, expect } from "vitest";
import {
  buildVideoReadyDetail,
  buildVideoErrorDetail,
  friendlyVideoError,
  escapeDrawText,
} from "./repurpose-video";

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

describe("escapeDrawText", () => {
  it("escapes double-quotes for defense-in-depth (no raw \" survives)", () => {
    const out = escapeDrawText('a"b$(x)`c');
    // Every double-quote must be backslash-escaped — none may survive raw.
    expect(out).not.toMatch(/(?<!\\)"/);
    expect(out).toContain('\\"');
  });

  it("strips ASCII control characters to spaces", () => {
    const withControls = `line${String.fromCharCode(0)}one${String.fromCharCode(7)}two${String.fromCharCode(31)}`;
    const out = escapeDrawText(withControls);
    // No control char (0x00–0x1F) may remain in the output.
    expect(out).not.toMatch(/[\x00-\x1f]/);
  });

  it("keeps the existing drawtext escapes (colon / brackets)", () => {
    const out = escapeDrawText("a:b[c]d");
    expect(out).toContain("\\:");
    expect(out).toContain("\\[");
    expect(out).toContain("\\]");
  });

  it("converts single-quotes to a typographic apostrophe (existing behaviour)", () => {
    const out = escapeDrawText("it's");
    expect(out).not.toContain("'");
  });
});

describe("friendlyVideoError", () => {
  it("returns a GENERIC safe message when no bucket matches (never leaks raw)", () => {
    const raw = "some raw provider blurb with no markers";
    const out = friendlyVideoError(raw);
    expect(out).not.toContain("raw provider blurb");
    expect(out).toBe("Video generation failed. Please try again or contact support.");
  });

  it("maps billing/dunning errors to the temporarily-unavailable message", () => {
    const out = friendlyVideoError("billing dunning decision is deny PERMISSION_DENIED");
    expect(out).toContain("temporarily unavailable");
  });

  it("maps missing-key errors to the configure message", () => {
    const out = friendlyVideoError("FAL_KEY is required");
    expect(out).toContain("not configured");
  });

  it("scrubs leaked Google project IDs / JSON to a generic provider-error message", () => {
    const out = friendlyVideoError('failed projects/518560861182 "status": 500');
    expect(out).not.toContain("518560861182");
    expect(out).toContain("provider error");
  });
});
