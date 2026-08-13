import { describe, it, expect } from "vitest";
import {
  platformMetricCapabilities,
  reportableMetrics,
  effectiveChannelUnavailable,
} from "../lib/platform-metrics";

/**
 * "Impressions" was the wrong name on five of the eight platforms that report
 * analytics.
 *
 * Surveyed 2026-08-13 across every provider's getPostAnalytics return:
 *
 *   INSTAGRAM  metrics.views        (Meta DELETED `impressions` in v22.0)
 *   YOUTUBE    statistics.viewCount (Data API v3 has no impressions metric)
 *   THREADS    views
 *   DEVTO      page_views_count
 *   REDDIT     view_count
 *   FACEBOOK   post_media_view      — renders/plays, AND a separate
 *                                     post_video_views for qualified views
 *   TWITTER    impression_count     — a genuine impressions metric
 *   LINKEDIN   impressions          — a genuine impressions metric
 *
 * So the column showed a VIEW count under an IMPRESSIONS label for the majority
 * of connected channels. These tests lock the corrected capability map.
 */
describe("views capability — the five platforms that never had impressions", () => {
  for (const platform of ["INSTAGRAM", "YOUTUBE", "THREADS", "DEVTO", "REDDIT"]) {
    it(`${platform}: declares impressions UNAVAILABLE and views available`, () => {
      const caps = platformMetricCapabilities(platform);
      expect(caps.unavailable).toContain("impressions");
      expect(caps.unavailable).not.toContain("views");

      const keys = reportableMetrics([platform]);
      expect(keys).not.toContain("impressions");
      expect(keys).toContain("views");
    });
  }

  it("🔴 FACEBOOK keeps BOTH — they are genuinely different numbers", () => {
    // post_media_view 5,063 vs post_video_views 1,468 on the same reel (3.45x).
    // Collapsing these would misreport Facebook views by a factor of three.
    const caps = platformMetricCapabilities("FACEBOOK");
    expect(caps.unavailable).not.toContain("views");
    // impressions stays in the static list; per-capture declaration widens it.
    const keys = reportableMetrics(["FACEBOOK"], [{ impressions: true, views: true }]);
    expect(keys).toContain("impressions");
    expect(keys).toContain("views");
  });

  it("⚠️ FACEBOOK's static unavailable array is unchanged — capability widens per capture", () => {
    // Editing this array was PR #148's mistake: it hid real, captured video
    // views behind "—". Capability must widen from what captures reported.
    expect(platformMetricCapabilities("FACEBOOK").unavailable.slice().sort()).toEqual([
      "impressions",
      "reach",
    ]);
  });

  for (const platform of ["TWITTER", "LINKEDIN", "PINTEREST"]) {
    it(`${platform}: has a real impressions metric and NO view count`, () => {
      const caps = platformMetricCapabilities(platform);
      expect(caps.unavailable).toContain("views");
      expect(caps.unavailable).not.toContain("impressions");
      expect(reportableMetrics([platform])).not.toContain("views");
    });
  }

  it("an unknown platform defaults views to UNAVAILABLE, never a fabricated 0", () => {
    expect(platformMetricCapabilities("SOMETHING_NEW").unavailable).toContain("views");
    expect(reportableMetrics(["SOMETHING_NEW"])).not.toContain("views");
  });

  it("a platform with no analytics API at all reports no views", () => {
    expect(platformMetricCapabilities("TELEGRAM").unavailable).toContain("views");
  });

  it("a mixed FB+IG org shows Views AND Impressions — they are not the same number", () => {
    const keys = reportableMetrics(["FACEBOOK", "INSTAGRAM"], [{ impressions: true }]);
    expect(keys).toContain("views"); // IG (and FB video)
    expect(keys).toContain("impressions"); // FB post_media_view
  });

  describe("effectiveChannelUnavailable — aggregate side", () => {
    it("hides views for a channel where no capture ever reported one", () => {
      const un = effectiveChannelUnavailable("INSTAGRAM", { views: false }, false);
      expect(un).toContain("views");
    });

    it("shows views as soon as ANY capture reported one", () => {
      const un = effectiveChannelUnavailable("INSTAGRAM", { views: true }, false);
      expect(un).not.toContain("views");
    });

    it("a legacy metadata-less channel falls back to the static map", () => {
      // Pre-views rows have no declaration at all; the static map decides, which
      // for Instagram means views is allowed (it is the platform's real metric)
      // while impressions is not.
      const un = effectiveChannelUnavailable("INSTAGRAM", undefined, true);
      expect(un).toContain("impressions");
      expect(un).not.toContain("views");
    });
  });
});
