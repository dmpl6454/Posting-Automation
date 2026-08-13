import { describe, it, expect } from "vitest";
import { gatePostReportRow, type PostReportRow } from "../routers/analytics.router";

/**
 * Locks the per-platform honesty gate for Reports rows: a metric the platform
 * NEVER reports must become null (UI "—"), a metric it DOES report stays a real
 * number (a captured 0 is a real 0). Mirrors metricCellValue so Reports and the
 * Channel Performance table agree. See gatePostReportRow.
 */
function row(platform: string, over: Partial<PostReportRow> = {}): PostReportRow {
  return {
    targetId: "t",
    postId: "p",
    contentPreview: "x",
    channelName: "c",
    channelUsername: null,
    platform,
    publishedAt: null,
    publishedUrl: null,
    impressions: 100,
    clicks: 5,
    likes: 10,
    comments: 2,
    shares: 3,
    reach: 50,
    views: 100,
    engagementRate: 1.5,
    snapshotAt: null,
    ...over,
  };
}

describe("gatePostReportRow — per-platform Reports honesty", () => {
  it("FACEBOOK: impressions AND reach → null (Meta deleted them); reactions/comments/shares/clicks stay real", () => {
    const g = gatePostReportRow(row("FACEBOOK"));
    expect(g.impressions).toBeNull();
    expect(g.reach).toBeNull();
    // These DO work on FB and must remain numeric (incl. a captured 0).
    expect(g.likes).toBe(10);
    expect(g.comments).toBe(2);
    expect(g.shares).toBe(3);
    expect(g.clicks).toBe(5);
  });

  it("FACEBOOK: a captured 0 on an AVAILABLE metric stays 0 (not '—')", () => {
    const g = gatePostReportRow(row("FACEBOOK", { comments: 0, shares: 0 }));
    expect(g.comments).toBe(0);
    expect(g.shares).toBe(0);
    // still-unavailable ones are null regardless of value
    expect(g.impressions).toBeNull();
    expect(g.reach).toBeNull();
  });

  /**
   * ⚠️ UPDATED 2026-08-13 — this used to assert `impressions === 100` for
   * Instagram. That encoded the mislabelling: Meta DELETED the IG impressions
   * metric in v22.0 ("no longer supported for the queried media"), and what the
   * provider stores in that slot has always been Meta's `views` count. IG now
   * declares impressions unavailable and the number surfaces as Views, so the
   * same figure is reported once under its real name instead of twice under two.
   */
  it("INSTAGRAM: views is the real metric; impressions → null (Meta deleted it); clicks → null", () => {
    const g = gatePostReportRow(row("INSTAGRAM"));
    expect(g.impressions).toBeNull();
    expect(g.views).toBe(100);
    expect(g.reach).toBe(50);
    expect(g.clicks).toBeNull();
    expect(g.shares).toBe(3);
  });

  /**
   * ⚠️ UPDATED 2026-08-13 — same correction as Instagram. YouTube Data API v3
   * `statistics` exposes viewCount / likeCount / commentCount only; there is no
   * impressions metric, and the provider has always mapped viewCount into that
   * slot.
   */
  it("YOUTUBE: views is the real metric; impressions/reach/clicks/shares → null", () => {
    const g = gatePostReportRow(row("YOUTUBE"));
    expect(g.reach).toBeNull();
    expect(g.clicks).toBeNull();
    expect(g.shares).toBeNull();
    expect(g.impressions).toBeNull();
    expect(g.views).toBe(100);
    expect(g.likes).toBe(10);
    expect(g.comments).toBe(2);
  });

  it("LINKEDIN: everything reported stays real (distinct reach, has clicks)", () => {
    const g = gatePostReportRow(row("LINKEDIN"));
    expect(g.impressions).toBe(100);
    expect(g.reach).toBe(50);
    expect(g.clicks).toBe(5);
  });

  it("TWITTER: reach aliased → null (reachIsDistinct false), clicks → null", () => {
    const g = gatePostReportRow(row("TWITTER"));
    expect(g.reach).toBeNull();
    expect(g.clicks).toBeNull();
    expect(g.impressions).toBe(100);
  });

  it("passes through null (no snapshot) untouched and never fabricates a number", () => {
    const g = gatePostReportRow(
      row("INSTAGRAM", { impressions: null, reach: null, likes: null, comments: null, shares: null, clicks: null })
    );
    expect(g.impressions).toBeNull();
    expect(g.reach).toBeNull();
    expect(g.likes).toBeNull();
  });

  it("unknown platform uses safe defaults (nothing marked unavailable, reach aliased → null)", () => {
    const g = gatePostReportRow(row("SOMETHING_NEW"));
    // DEFAULT_CAPS: reachIsDistinct false → reach null; nothing else unavailable
    expect(g.reach).toBeNull();
    expect(g.impressions).toBe(100);
    expect(g.likes).toBe(10);
    expect(g.clicks).toBe(5);
  });

  it("preserves engagementRate normalization (number stays, null stays)", () => {
    // Uses INSTAGRAM. The rate is gated on the DELIVERY denominator — impressions
    // where the platform reports them, VIEWS where it does not. Instagram has no
    // impressions metric, so its rate now rides on views; gating on impressions
    // alone would blank the rate for every IG and YouTube channel.
    expect(gatePostReportRow(row("INSTAGRAM", { engagementRate: 2.5 })).engagementRate).toBe(2.5);
    expect(gatePostReportRow(row("INSTAGRAM", { engagementRate: null })).engagementRate).toBeNull();
  });

  it("nulls engagementRate whenever impressions are unavailable (2026-08-06)", () => {
    // Engagement rate IS engagement ÷ impressions, so it can only be as honest
    // as its denominator. Facebook Page posts no longer report impressions at
    // all (Meta deleted the metric — re-verified WITH read_insights granted), so
    // printing a rate there means deriving it from a number the UI is
    // simultaneously rendering as "—". Worse, "0.00%" reads as "no engagement"
    // when the truth is "not reported".
    // ⚠️ `views: null` matters (added 2026-08-13). The rate's denominator is now
    // impressions OR views, because five platforms have no impressions metric at
    // all. The property this test protects is unchanged — never print a rate whose
    // denominator is hidden — but expressing it requires BOTH to be absent, which
    // is exactly the shape of a legacy Facebook row that captured neither.
    const fb = gatePostReportRow(row("FACEBOOK", { engagementRate: 2.5, views: null }));
    expect(fb.impressions).toBeNull();
    expect(fb.views).toBeNull();
    expect(fb.engagementRate).toBeNull();

    // And a FB row that DID capture video views keeps its rate, since the
    // denominator is then visible in the Views column.
    const fbViews = gatePostReportRow(row("FACEBOOK", { engagementRate: 2.5, views: 1468 }));
    expect(fbViews.views).toBe(1468);
    expect(fbViews.engagementRate).toBe(2.5);

    // But a FB VIDEO capture that DID report views keeps its rate: the
    // per-snapshot override makes impressions available, so the ratio is real.
    const fbVideo = gatePostReportRow(
      row("FACEBOOK", {
        engagementRate: 2.5,
        snapshotMetadata: { metricsAvailable: { impressions: true } },
      })
    );
    expect(fbVideo.impressions).toBe(100);
    expect(fbVideo.engagementRate).toBe(2.5);
  });
});

/**
 * Regression lock (2026-07-27): PER-SNAPSHOT metricsAvailable overrides the static
 * platform map. PR #148 marked FACEBOOK impressions+reach unavailable platform-wide,
 * which is right for FEED posts (Meta deleted those insight metrics) but WRONG for
 * VIDEO/REEL posts, whose real view counts arrive via video_insights /the reel
 * scraper and land in the impressions slot. Those capture paths deliberately do NOT
 * declare impressions unavailable — so real, captured data was being hidden as "—".
 */
describe("gatePostReportRow — per-snapshot metricsAvailable wins over the static map", () => {
  it("FB VIDEO: capture did not mark impressions unavailable → real views survive", () => {
    const g = gatePostReportRow(
      row("FACEBOOK", {
        impressions: 11239,
        snapshotMetadata: { metricsAvailable: { reach: false, shares: false, clicks: false } },
      })
    );
    expect(g.impressions).toBe(11239); // was null before the fix — real views hidden
    expect(g.reach).toBeNull();
    expect(g.shares).toBeNull();
    expect(g.clicks).toBeNull();
    expect(g.likes).toBe(10);
  });

  it("FB FEED: capture explicitly marks impressions/reach unavailable → still '—'", () => {
    const g = gatePostReportRow(
      row("FACEBOOK", {
        impressions: 0,
        reach: 0,
        snapshotMetadata: {
          metricsAvailable: { impressions: false, reach: false, comments: false },
        },
      })
    );
    expect(g.impressions).toBeNull();
    expect(g.reach).toBeNull();
    expect(g.comments).toBeNull();
    // ⚠️ UPDATED 2026-08-07 — this used to assert `shares === 3`, encoding the rule
    // "the capture declared other keys, so an omitted one must have worked". Production
    // disproved that for FACEBOOK `shares` specifically: it is read from the post-FIELDS
    // edge while clicks/likes come from the post-INSIGHTS edge, so the fields call can
    // fail silently while insights succeeds — leaving `shares` omitted and stored as 0,
    // which then rendered as a confident "0 shares" (12 prod snapshots; users reported it
    // as "shares not working"). An undeclared FB `shares` is now "—".
    // See shares-visibility.test.ts and requiresExplicitDeclaration().
    expect(g.shares).toBeNull();
  });

  it("no snapshot metadata (legacy rows) → static platform map, byte-identical behavior", () => {
    const g = gatePostReportRow(row("FACEBOOK", { snapshotMetadata: null }));
    expect(g.impressions).toBeNull();
    expect(g.reach).toBeNull();
    expect(g.likes).toBe(10);
  });

  it("an explicitly captured 0 on an AVAILABLE metric stays 0, never '—'", () => {
    const g = gatePostReportRow(
      row("FACEBOOK", {
        impressions: 0,
        snapshotMetadata: { metricsAvailable: { reach: false } },
      })
    );
    expect(g.impressions).toBe(0);
  });
});
