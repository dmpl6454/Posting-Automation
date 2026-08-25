import { describe, it, expect } from "vitest";
import { planFacebookAnalyticsId } from "../lib/fb-video-post-id";

/**
 * Facebook VIDEO/REEL analytics: a bare Video-node id must be resolved to a
 * composite "{pageId}_{postId}" before insights are requested.
 *
 * ── LIVE-PROVEN on production 2026-08-25 ─────────────────────────────────────
 * A video publish stores a BARE Video id in PostTarget.publishedId (the /videos edge
 * returns only {id}). `getPostAnalytics` routes bare ids to the Video node, and the
 * Video node reports NOTHING for a reel — `video_insights` returned EMPTY200 for both
 * of Aditi's reels. Resolving the id and asking the POST node instead returned real
 * data on the very same posts:
 *
 *   Maahadev  → post_media_view=4  post_total_media_view_unique=1  post_video_views=1
 *   LastSawan → post_media_view=5  post_total_media_view_unique=1  post_video_views=1
 *
 * The app was showing impressions 1 / reach 0 / views "—" for those. Permissions were
 * never the issue: the same token answered both calls.
 *
 * ⚠️ `resolveVideoPostId` previously had exactly ONE caller — external-post-sync —
 * which went dormant on 2026-08-19, so app-published reels silently stopped being
 * resolved. This planner puts the resolution on the app-published path where it
 * belongs, and makes it a ONE-TIME cost by persisting the result.
 */
describe("planFacebookAnalyticsId", () => {
  it("resolves a BARE Facebook video id", () => {
    expect(planFacebookAnalyticsId({ platform: "FACEBOOK", publishedId: "1421711249824693" }))
      .toEqual({ analyticsId: null, needsResolve: true });
  });

  it("reuses a previously stored resolvedPostId — no repeat Graph call", () => {
    // The whole point of persisting it: one extra call per video, ever.
    expect(planFacebookAnalyticsId({
      platform: "FACEBOOK",
      publishedId: "1421711249824693",
      resolvedPostId: "1236722272855320_122112280047402974",
    })).toEqual({ analyticsId: "1236722272855320_122112280047402974", needsResolve: false });
  });

  it("leaves a COMPOSITE Facebook id alone", () => {
    // Feed posts already carry {page}_{post}; touching them would add a pointless
    // call to the commonest path.
    expect(planFacebookAnalyticsId({
      platform: "FACEBOOK",
      publishedId: "1236722272855320_122112315603402974",
    })).toEqual({ analyticsId: "1236722272855320_122112315603402974", needsResolve: false });
  });

  it("never resolves for a non-Facebook platform", () => {
    // Instagram media ids are bare by design and are NOT Video nodes.
    for (const platform of ["INSTAGRAM", "YOUTUBE", "TWITTER", "LINKEDIN"]) {
      expect(planFacebookAnalyticsId({ platform, publishedId: "17944314135298566" }))
        .toEqual({ analyticsId: "17944314135298566", needsResolve: false });
    }
  });

  it("ignores a blank or malformed stored resolvedPostId", () => {
    // A stored value must itself be composite, or we would ask the Video node again
    // under a different name and silently get EMPTY200 forever.
    for (const bad of ["", "   ", "not-composite"]) {
      expect(planFacebookAnalyticsId({
        platform: "FACEBOOK", publishedId: "1421711249824693", resolvedPostId: bad,
      })).toEqual({ analyticsId: null, needsResolve: true });
    }
  });

  it("treats a missing publishedId as nothing to do", () => {
    expect(planFacebookAnalyticsId({ platform: "FACEBOOK", publishedId: "" }))
      .toEqual({ analyticsId: null, needsResolve: false });
  });
});

import { earlyVideoSyncDelayMs, DEFAULT_EARLY_VIDEO_SYNC_DELAY_MS } from "../lib/fb-video-post-id";

/**
 * The early one-shot sync exists because FACEBOOK is excluded from BOTH recurring
 * analytics passes, so the next thing to touch a freshly published reel is the 24h
 * at-age checkpoint. Without an early pass a user who just published sees views "—"
 * for a full day — the exact report that started this investigation.
 */
describe("earlyVideoSyncDelayMs", () => {
  it("defaults to 45 minutes", () => {
    expect(earlyVideoSyncDelayMs(undefined)).toBe(DEFAULT_EARLY_VIDEO_SYNC_DELAY_MS);
    expect(earlyVideoSyncDelayMs(null)).toBe(DEFAULT_EARLY_VIDEO_SYNC_DELAY_MS);
  });

  it("fails CLOSED to the default on an empty or garbage value", () => {
    // An unplumbed compose key arrives as "", and Number("") is 0 — which would fire
    // instantly and store the zero Meta has not populated yet.
    for (const raw of ["", "   ", "abc", "-1", "0"]) {
      expect(earlyVideoSyncDelayMs(raw), `raw=${raw}`).toBe(DEFAULT_EARLY_VIDEO_SYNC_DELAY_MS);
    }
  });

  it("honors an explicit longer delay", () => {
    expect(earlyVideoSyncDelayMs(String(90 * 60 * 1000))).toBe(90 * 60 * 1000);
  });

  it("floors at 5 minutes — sooner cannot have data", () => {
    // Measured on a real post: views read 0 at ~30 min, then 1, then 2. A 1-minute
    // delay would spend a call to learn nothing.
    expect(earlyVideoSyncDelayMs("60000")).toBe(5 * 60 * 1000);
  });
});
