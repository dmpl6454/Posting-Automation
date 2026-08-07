import { describe, it, expect } from "vitest";
import { gatePostReportRow, type PostReportRow } from "../routers/analytics.router";
import { effectiveChannelUnavailable, requiresExplicitDeclaration } from "../lib/platform-metrics";

/**
 * "Shares are not working / not visible in Insights" — the user-reported bug.
 *
 * Measured on prod 2026-08-07:
 *   FACEBOOK   12 snapshots (2026-08-02 → 2026-08-07) have the `shares` key OMITTED from
 *              metricsAvailable AND shares = 0  ⇒ rendered as a confident "0"
 *   INSTAGRAM  63 of 64 snapshots declare shares:false AND carry `degraded`
 *              ⇒ correctly rendered "—" (dead tokens, not a shares bug)
 *
 * Root cause of the FB case: `shares` is read from the post-FIELDS edge while
 * `clicks`/`likes` come from the post-INSIGHTS edge. Insights could succeed (declaring
 * clicks/likes) while the fields call silently failed, leaving `shares` omitted. The
 * generic rule "capture declared others ⇒ an omitted key worked" then published a 0.
 *
 * Graph also OMITS `shares` for a post with genuinely zero shares, so "0 shares" and
 * "could not read shares" are indistinguishable in storage — "—" is the only honest
 * render for a capture that never declared it.
 */

function row(over: Partial<PostReportRow> = {}): PostReportRow {
  return {
    targetId: "t1",
    postId: "p1",
    contentPreview: "x",
    channelName: "Bollywood",
    channelUsername: "b",
    platform: "FACEBOOK",
    publishedAt: new Date("2026-08-05T00:00:00Z"),
    publishedUrl: null,
    impressions: 0,
    clicks: 4,
    likes: 6,
    comments: 0,
    shares: 0,
    reach: 0,
    engagementRate: 0,
    snapshotAt: new Date("2026-08-06T00:00:00Z"),
    ...over,
  };
}

describe("shares visibility (user-reported bug)", () => {
  it("FACEBOOK: an OMITTED shares key renders '—', not a fake 0 (the 12 prod rows)", () => {
    const gated = gatePostReportRow(
      row({
        shares: 0,
        snapshotMetadata: {
          // Exactly the pre-fix provider shape: insights succeeded, fields did not.
          metricsAvailable: { impressions: false, reach: false, clicks: true, likes: true },
        },
      })
    );

    expect(gated.shares).toBeNull(); // ← was 0 before the fix
    // Siblings that WERE declared stay real.
    expect(gated.clicks).toBe(4);
    expect(gated.likes).toBe(6);
  });

  it("FACEBOOK: an EXPLICIT shares:true keeps a genuine 0 (post really had no shares)", () => {
    const gated = gatePostReportRow(
      row({ shares: 0, snapshotMetadata: { metricsAvailable: { clicks: true, shares: true } } })
    );
    expect(gated.shares).toBe(0); // a real zero must NOT become "—"
  });

  it("FACEBOOK: an explicit shares:false renders '—'", () => {
    const gated = gatePostReportRow(
      row({ shares: 0, snapshotMetadata: { metricsAvailable: { clicks: true, shares: false } } })
    );
    expect(gated.shares).toBeNull();
  });

  it("FACEBOOK: a real share count is always shown when declared", () => {
    const gated = gatePostReportRow(
      row({ shares: 7, snapshotMetadata: { metricsAvailable: { shares: true } } })
    );
    expect(gated.shares).toBe(7);
  });

  it("INSTAGRAM: shares are NOT subject to the rule — an omitted key stays available", () => {
    // IG reads every metric from ONE insights call, so siblings are valid evidence.
    // Its 63 prod rows render "—" via an explicit shares:false, not via omission.
    const gated = gatePostReportRow(
      row({ platform: "INSTAGRAM", shares: 3, snapshotMetadata: { metricsAvailable: { reach: true } } })
    );
    expect(gated.shares).toBe(3);
  });

  it("INSTAGRAM: the real prod shape (explicit false + degraded) renders '—'", () => {
    const gated = gatePostReportRow(
      row({
        platform: "INSTAGRAM",
        shares: 0,
        snapshotMetadata: {
          metricsAvailable: { impressions: false, reach: false, shares: false },
        },
      })
    );
    expect(gated.shares).toBeNull();
  });

  it("legacy rows with NO metadata still fall back to the static map (unchanged)", () => {
    const gated = gatePostReportRow(row({ shares: 5, snapshotMetadata: null }));
    // FACEBOOK's static map does not list shares as unavailable ⇒ show it.
    expect(gated.shares).toBe(5);
  });

  it("requiresExplicitDeclaration is narrow — only FB shares, nothing else", () => {
    expect(requiresExplicitDeclaration("FACEBOOK", "shares")).toBe(true);
    expect(requiresExplicitDeclaration("FACEBOOK", "clicks")).toBe(false);
    expect(requiresExplicitDeclaration("FACEBOOK", "likes")).toBe(false);
    expect(requiresExplicitDeclaration("INSTAGRAM", "shares")).toBe(false);
    expect(requiresExplicitDeclaration("YOUTUBE", "shares")).toBe(false);
  });
});

describe("shares visibility — the per-row rule must NOT leak into the aggregate", () => {
  /**
   * ⚠️ REGRESSION GUARD (prod incident 2026-08-07).
   *
   * requiresExplicitDeclaration is a PER-ROW rule: on one capture, an omitted `shares`
   * really does mean that capture's fields call never resolved. On the AGGREGATE it is
   * semantically wrong — `declaredAvailable` there is a BOOL_OR across EVERY capture on
   * the channel, so it already answers "did ANY capture report this?".
   *
   * Applying the per-row rule to the aggregate blanked the Shares column for entire
   * channels and hid thousands of real captured shares: every FB row rendered "—" in
   * Channel Performance while the stored metricsAvailable held shares:true.
   */
  it("does NOT mark shares unavailable just because the aggregate lacks the key", () => {
    const unavailable = effectiveChannelUnavailable(
      "FACEBOOK",
      { impressions: false, reach: false, clicks: true, likes: true },
      false
    );
    // No capture reported shares ⇒ fall through to the static map, which permits
    // shares on FACEBOOK. It must NOT be force-hidden.
    expect(unavailable).not.toContain("shares");
  });

  it("the real prod aggregate (shares:true) keeps the column visible", () => {
    // Exactly what prod stores after the ingestion pipeline ran.
    const unavailable = effectiveChannelUnavailable(
      "FACEBOOK",
      { likes: true, reach: false, clicks: true, shares: true, comments: true, impressions: false },
      false
    );
    expect(unavailable).not.toContain("shares");
    expect(unavailable).toContain("impressions"); // Meta deleted these — still hidden
    expect(unavailable).toContain("reach");
  });

  it("a declared shares:true keeps the column visible", () => {
    const unavailable = effectiveChannelUnavailable("FACEBOOK", { shares: true }, false);
    expect(unavailable).not.toContain("shares");
  });

  it("a legacy capture (no claim at all) still defers to the static map", () => {
    // hasLegacySnapshot ⇒ static map, which allows shares on FACEBOOK.
    const unavailable = effectiveChannelUnavailable("FACEBOOK", undefined, true);
    expect(unavailable).not.toContain("shares");
  });

  it("INSTAGRAM is unaffected by the rule", () => {
    const unavailable = effectiveChannelUnavailable("INSTAGRAM", { reach: true }, false);
    expect(unavailable).not.toContain("shares");
  });
});
