import { describe, it, expect } from "vitest";
import { MEDIA_REQUIRED_PLATFORMS, mediaRequiredBlock } from "../media-required";

describe("MEDIA_REQUIRED_PLATFORMS", () => {
  it("contains exactly FACEBOOK, INSTAGRAM and SNAPCHAT (all reject text-only posts)", () => {
    expect([...MEDIA_REQUIRED_PLATFORMS].sort()).toEqual(["FACEBOOK", "INSTAGRAM", "SNAPCHAT"]);
  });
});

describe("mediaRequiredBlock", () => {
  it("blocks an Instagram target with no media and AI off", () => {
    const reason = mediaRequiredBlock({ platforms: ["INSTAGRAM"], hasMedia: false, aiEnabled: false });
    expect(reason).toBeTypeOf("string");
    expect(reason).toContain("Instagram");
    expect(reason!.toLowerCase()).toContain("image");
  });

  it("blocks a Facebook target with no media and AI off", () => {
    const reason = mediaRequiredBlock({ platforms: ["FACEBOOK"], hasMedia: false, aiEnabled: false });
    expect(reason).toContain("Facebook");
  });

  it("blocks a Snapchat target with no media and AI off (no text-only snaps)", () => {
    const reason = mediaRequiredBlock({ platforms: ["SNAPCHAT"], hasMedia: false, aiEnabled: false });
    expect(reason).toContain("Snapchat");
  });

  it("names every blocked platform when multiple media-required targets are media-less", () => {
    const reason = mediaRequiredBlock({ platforms: ["INSTAGRAM", "FACEBOOK", "TWITTER"], hasMedia: false, aiEnabled: false });
    expect(reason).toContain("Instagram");
    expect(reason).toContain("Facebook");
    expect(reason).not.toContain("Twitter");
  });

  it("allows when media is attached", () => {
    expect(mediaRequiredBlock({ platforms: ["INSTAGRAM"], hasMedia: true, aiEnabled: false })).toBeNull();
  });

  it("allows when AI generation is enabled (worker can auto-generate)", () => {
    expect(mediaRequiredBlock({ platforms: ["INSTAGRAM"], hasMedia: false, aiEnabled: true })).toBeNull();
  });

  it("allows non-media-required platforms with no media", () => {
    expect(mediaRequiredBlock({ platforms: ["TWITTER", "LINKEDIN"], hasMedia: false, aiEnabled: false })).toBeNull();
  });

  it("allows an empty platform list", () => {
    expect(mediaRequiredBlock({ platforms: [], hasMedia: false, aiEnabled: false })).toBeNull();
  });

  it("is case-insensitive on platform names", () => {
    expect(mediaRequiredBlock({ platforms: ["instagram"], hasMedia: false, aiEnabled: false })).toContain("Instagram");
  });
});
