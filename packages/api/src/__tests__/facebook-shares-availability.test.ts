import { describe, it, expect } from "vitest";
import { gatePostReportRow, type PostReportRow } from "../routers/analytics.router";

/**
 * FACEBOOK `shares` SILENT ZERO — measured on prod 2026-08-06 (26 captures
 * across 17 targets stored shares:0 from a fetch that never resolved).
 *
 * facebook.provider declared metricsAvailable for impressions/reach/clicks/
 * comments/likes but OMITTED `shares`. Per the precedence rule in
 * gatePostReportRow — "metadata present and the key not false ⇒ trust the
 * value" — an omitted key reads as AVAILABLE. So when the post-fields fetch
 * failed (missing pages_read_user_content) AND the isolated shares retry also
 * failed, `shares` stayed 0 and rendered as a confident zero, indistinguishable
 * from a post that genuinely had no shares.
 */

function row(over: Partial<PostReportRow> = {}): PostReportRow {
  return {
    targetId: "t1",
    postId: "p1",
    contentPreview: "x",
    channelName: "Bollywood",
    channelUsername: "bolly",
    platform: "FACEBOOK",
    publishedAt: new Date("2026-08-06T00:00:00Z"),
    publishedUrl: null,
    impressions: 0,
    clicks: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    reach: 0,
    engagementRate: 0,
    snapshotAt: new Date("2026-08-06T01:00:00Z"),
    ...over,
  };
}

describe("facebook shares availability", () => {
  it("renders '—' when the capture declared shares unavailable (fetch failed)", () => {
    const gated = gatePostReportRow(
      row({
        snapshotMetadata: {
          metricsAvailable: {
            impressions: false,
            reach: false,
            clicks: true,
            comments: false,
            likes: true,
            shares: false, // the fix: explicitly declared
          },
        },
      })
    );

    expect(gated.shares).toBeNull(); // "—", not a fake 0
    expect(gated.comments).toBeNull();
    expect(gated.likes).toBe(0); // real captured value
  });

  it("keeps a genuine 0 when the fetch SUCCEEDED and the post truly has no shares", () => {
    const gated = gatePostReportRow(
      row({
        snapshotMetadata: {
          metricsAvailable: {
            impressions: false,
            reach: false,
            clicks: true,
            comments: true,
            likes: true,
            shares: true, // fetch resolved; Graph omits `shares` at zero
          },
        },
      })
    );

    expect(gated.shares).toBe(0); // a real zero must NOT become "—"
  });

  it("legacy captures (no metadata) still fall back to the static map, unchanged", () => {
    const gated = gatePostReportRow(row({ shares: 3, snapshotMetadata: null }));
    // FACEBOOK's static map does not list shares as unavailable.
    expect(gated.shares).toBe(3);
    // …but impressions/reach are statically unavailable for FB.
    expect(gated.impressions).toBeNull();
    expect(gated.reach).toBeNull();
  });

  it("an OMITTED shares key on FACEBOOK now renders '—' (the read-side half of the fix)", () => {
    const gated = gatePostReportRow(
      row({
        shares: 0,
        snapshotMetadata: {
          // shares deliberately omitted — the pre-fix provider shape, still present in
          // 12 prod snapshots written 2026-08-02 → 2026-08-07.
          metricsAvailable: { impressions: false, reach: false, comments: false },
        },
      })
    );
    // ⚠️ This assertion was `toBe(0)` when the suite was written, documenting the hazard
    // as unavoidable for pre-fix rows. It is now fixed on the READ side too
    // (requiresExplicitDeclaration), so those stale rows stop publishing a fake 0 rather
    // than waiting to self-heal on their next capture. The provider-side fix (declaring
    // `shares` explicitly) still matters — it is what makes NEW captures trustworthy.
    expect(gated.shares).toBeNull();
  });
});
