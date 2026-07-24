import { describe, it, expect } from "vitest";
import { platformMetricCapabilities, NO_ANALYTICS_PLATFORMS } from "../lib/platform-metrics";

describe("platformMetricCapabilities", () => {
  it("labels the likes slot honestly per platform", () => {
    expect(platformMetricCapabilities("FACEBOOK").likeKind).toBe("reactions");
    expect(platformMetricCapabilities("PINTEREST").likeKind).toBe("saves");
    expect(platformMetricCapabilities("REDDIT").likeKind).toBe("upvotes");
    expect(platformMetricCapabilities("YOUTUBE").likeKind).toBe("likes");
  });

  it("marks reach distinct only for platforms with a real reach metric", () => {
    expect(platformMetricCapabilities("LINKEDIN").reachIsDistinct).toBe(true);
    expect(platformMetricCapabilities("INSTAGRAM").reachIsDistinct).toBe(true);
    expect(platformMetricCapabilities("FACEBOOK").reachIsDistinct).toBe(true);
    // view-aliased-reach platforms → not distinct (UI shows "—" for reach)
    expect(platformMetricCapabilities("YOUTUBE").reachIsDistinct).toBe(false);
    expect(platformMetricCapabilities("TWITTER").reachIsDistinct).toBe(false);
    expect(platformMetricCapabilities("REDDIT").reachIsDistinct).toBe(false);
  });

  it("marks clicks unavailable for the platforms that never report them", () => {
    for (const p of ["INSTAGRAM", "YOUTUBE", "TWITTER", "THREADS", "REDDIT", "DEVTO"]) {
      expect(platformMetricCapabilities(p).unavailable).toContain("clicks");
    }
    // LinkedIn/FB/Pinterest DO report clicks
    expect(platformMetricCapabilities("LINKEDIN").unavailable).not.toContain("clicks");
    expect(platformMetricCapabilities("FACEBOOK").unavailable).not.toContain("clicks");
  });

  it("marks FB impressions AND reach unavailable — Meta deleted those metrics (render '—', not a fake 0)", () => {
    // Live-verified 2026-07-24: FB post_impressions*/reach 400 #100 for admin AND
    // external tokens. The provider hardcodes 0; the UI must render "—".
    const fb = platformMetricCapabilities("FACEBOOK");
    expect(fb.unavailable).toContain("impressions");
    expect(fb.unavailable).toContain("reach");
    // reactions/comments/shares/clicks DO work on FB → stay available.
    expect(fb.unavailable).not.toContain("likes");
    expect(fb.unavailable).not.toContain("comments");
    expect(fb.unavailable).not.toContain("shares");
    expect(fb.unavailable).not.toContain("clicks");
  });

  it("returns all-unavailable for platforms with no analytics API", () => {
    for (const p of NO_ANALYTICS_PLATFORMS) {
      const caps = platformMetricCapabilities(p);
      expect(caps.unavailable).toEqual(
        expect.arrayContaining(["impressions", "reach", "likes", "comments", "shares", "clicks"])
      );
    }
  });

  it("is case-insensitive and defaults safely for unknown platforms", () => {
    expect(platformMetricCapabilities("facebook").likeKind).toBe("reactions");
    expect(platformMetricCapabilities("SOMETHING_NEW").likeKind).toBe("likes");
  });
});
