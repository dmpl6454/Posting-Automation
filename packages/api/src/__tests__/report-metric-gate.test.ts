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

  it("INSTAGRAM: reach + impressions stay real (distinct); clicks → null (IG has no clicks)", () => {
    const g = gatePostReportRow(row("INSTAGRAM"));
    expect(g.impressions).toBe(100);
    expect(g.reach).toBe(50);
    expect(g.clicks).toBeNull();
    expect(g.shares).toBe(3);
  });

  it("YOUTUBE: reach/clicks/shares → null (aliased/absent); impressions/likes/comments stay real", () => {
    const g = gatePostReportRow(row("YOUTUBE"));
    expect(g.reach).toBeNull();
    expect(g.clicks).toBeNull();
    expect(g.shares).toBeNull();
    expect(g.impressions).toBe(100);
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
    expect(gatePostReportRow(row("FACEBOOK", { engagementRate: 2.5 })).engagementRate).toBe(2.5);
    expect(gatePostReportRow(row("FACEBOOK", { engagementRate: null })).engagementRate).toBeNull();
  });
});
