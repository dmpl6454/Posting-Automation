import { describe, it, expect } from "vitest";
import { gatePostReportRow } from "../routers/analytics.router";
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

/**
 * 🔴 THE GAP THAT LET THE DUPLICATE-COLUMN DEFECT SHIP.
 *
 * The tests above call `reportableMetrics([platform])` with ONE argument. Neither
 * production call site does: `analytics.engagement` and `analytics.postReports`
 * both pass the per-capture declarations as a second argument. And per-capture
 * `metricsAvailable` OVERRIDES the static map at every consumer.
 *
 * So the static `unavailable: ["impressions"]` edit was dead code in production
 * while the one-argument tests happily passed. Instagram shipped rendering
 * Impressions AND Views as two columns holding the identical number — measured on
 * 66,073 prod rows, both summing 2.26B, printed twice.
 *
 * LESSON: a capability test that does not use the production call shape is not
 * testing the production behaviour. Every case below passes declarations.
 */
describe("🔴 production-shaped: per-capture declarations must not resurrect impressions", () => {
  /** Exactly what instagram.provider now emits. */
  const IG_DECLARED = { impressions: false, views: true, reach: true, shares: true, clicks: false };
  /** Exactly what youtube.provider now emits. */
  const YT_DECLARED = {
    impressions: false,
    views: true,
    likes: true,
    comments: true,
    clicks: false,
    shares: false,
    reach: false,
  };
  /** Threads/dev.to/Reddit shape — the key must be PRESENT and false, never omitted. */
  const THREADS_DECLARED = { clicks: false, reach: false, impressions: false, views: true };

  it("INSTAGRAM: one column, not two", () => {
    const keys = reportableMetrics(["INSTAGRAM"], [IG_DECLARED]);
    expect(keys).toContain("views");
    expect(keys).not.toContain("impressions");
  });

  it("YOUTUBE: one column, not two", () => {
    const keys = reportableMetrics(["YOUTUBE"], [YT_DECLARED]);
    expect(keys).toContain("views");
    expect(keys).not.toContain("impressions");
  });

  it("THREADS/DEVTO/REDDIT: impressions stays out of the reportable set", () => {
    expect(reportableMetrics(["THREADS"], [THREADS_DECLARED])).not.toContain("impressions");
  });

  /**
   * ⚠️ WHERE THE OMITTED-KEY HAZARD ACTUALLY LIVES — measured, not assumed.
   *
   * `reportableMetrics` widens only on an explicit `true`, and
   * `effectiveChannelUnavailable` falls through to the static map, so BOTH
   * aggregate paths are safe with an omitted key. The per-ROW gate is not:
   * `gatePostReportRow` treats "this capture declared other keys, so an omitted
   * one must have worked" as available. That is why the five providers declare
   * `impressions: false` EXPLICITLY rather than simply dropping the key.
   */
  it("gatePostReportRow is the path that needs the explicit false", () => {
    const row = (declared: Record<string, boolean>) =>
      gatePostReportRow({
        targetId: "t", postId: "p", contentPreview: "x", channelName: "c",
        channelUsername: null, platform: "THREADS", publishedAt: null, publishedUrl: null,
        impressions: 500, clicks: null, likes: 1, comments: 0, shares: 0, reach: null,
        views: 500, engagementRate: 1, snapshotAt: null,
        snapshotMetadata: { metricsAvailable: declared },
      } as any);

    // Omitted ⇒ the capture's siblings vouch for it ⇒ a duplicate column.
    expect(row({ clicks: false, reach: false, views: true }).impressions).toBe(500);
    // Explicit false ⇒ "—", which is the truth for a platform with no such metric.
    expect(row(THREADS_DECLARED).impressions).toBeNull();
    expect(row(THREADS_DECLARED).views).toBe(500);
  });

  it("effectiveChannelUnavailable agrees — the aggregate side must not diverge", () => {
    // gatePostReportRow and effectiveChannelUnavailable disagreeing on an omitted
    // key is the same-page-two-answers class this repo has already fixed twice.
    expect(effectiveChannelUnavailable("INSTAGRAM", IG_DECLARED, false)).toContain("impressions");
    expect(effectiveChannelUnavailable("INSTAGRAM", IG_DECLARED, false)).not.toContain("views");
    expect(effectiveChannelUnavailable("YOUTUBE", YT_DECLARED, false)).toContain("impressions");
    expect(effectiveChannelUnavailable("THREADS", THREADS_DECLARED, false)).toContain("impressions");
  });

  it("a legacy metadata-less capture cannot resurrect a confident 'Views 0'", () => {
    // views availability comes from the COLUMN (BOOL_OR(views IS NOT NULL)), not
    // from metadata, so a definitive `false` must outrank the legacy fallback.
    expect(effectiveChannelUnavailable("FACEBOOK", { views: false }, true)).toContain("views");
  });

  it("FACEBOOK still shows both — it is the one platform where they differ", () => {
    const FB_DECLARED = { impressions: true, views: true, reach: true, clicks: true };
    const keys = reportableMetrics(["FACEBOOK"], [FB_DECLARED]);
    expect(keys).toContain("impressions");
    expect(keys).toContain("views");
  });

  it("a mixed FB+IG org keeps Impressions (from FB) and Views (from both)", () => {
    const keys = reportableMetrics(
      ["FACEBOOK", "INSTAGRAM"],
      [{ impressions: true, views: true }, IG_DECLARED]
    );
    expect(keys).toContain("impressions");
    expect(keys).toContain("views");
  });
});
