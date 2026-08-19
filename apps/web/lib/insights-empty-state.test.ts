import { describe, it, expect } from "vitest";
import { deriveInsightsEmptyState, type ChannelStatLike } from "./insights-empty-state";

/**
 * Which "nothing here" message Channel Performance should show.
 *
 * ⚠️ The bug this exists to prevent: the single pre-2026-08-19 banner said "no
 * engagement data has synced yet … try Sync Now, or check back later". Once
 * Insights narrowed to app-published posts only, that banner started firing for
 * every workspace that posts mainly DIRECTLY on the platform — and its advice is
 * unachievable there. Nothing is pending, so no amount of syncing or waiting will
 * ever populate the table. Telling a user to wait for data that cannot arrive is a
 * false statement about the system, not merely unhelpful copy.
 *
 * The two states are distinguishable from data already on the row: `postCount` is 0
 * when we published nothing, and non-zero with zero metrics when a capture is
 * genuinely outstanding.
 */

const row = (over: Partial<ChannelStatLike> = {}): ChannelStatLike => ({
  postCount: 0,
  impressions: 0,
  reach: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  ...over,
});

describe("deriveInsightsEmptyState", () => {
  it("returns 'none' when there are no channel rows at all", () => {
    // A separate empty state ("no channels connected") already covers this.
    expect(deriveInsightsEmptyState(undefined, false)).toBe("none");
    expect(deriveInsightsEmptyState([], false)).toBe("none");
  });

  it("returns 'no_app_posts' when nothing was published through us", () => {
    // Measured on prod 2026-08-19: tabish@dashmani's workspace has 121 connected
    // channels and 2 app-published posts; a workspace with 0 is the common case.
    expect(deriveInsightsEmptyState([row(), row()], false)).toBe("no_app_posts");
  });

  it("returns 'no_metrics_yet' when posts exist but carry no engagement", () => {
    // Here "try Sync Now" IS the correct advice — a capture really is outstanding.
    expect(deriveInsightsEmptyState([row({ postCount: 3 })], false)).toBe("no_metrics_yet");
  });

  it("returns 'none' as soon as ANY engagement is present", () => {
    expect(deriveInsightsEmptyState([row({ postCount: 3, likes: 1 })], false)).toBe("none");
    expect(deriveInsightsEmptyState([row({ postCount: 3, impressions: 10 })], false)).toBe("none");
    // Mixed: one quiet channel next to a busy one is a normal, healthy org.
    expect(
      deriveInsightsEmptyState([row(), row({ postCount: 5, likes: 20 })], false)
    ).toBe("none");
  });

  it("never claims 'no_app_posts' while DIRECT posts are included", () => {
    // With the wider population, postCount counts direct posts too, so 0 means
    // "no posts of any kind" — the generic sync message stays correct and the
    // app-published-specific wording would be wrong.
    expect(deriveInsightsEmptyState([row(), row()], true)).toBe("no_metrics_yet");
  });

  it("treats a missing counter as zero rather than throwing", () => {
    // Rows arrive over superjson from a procedure that has gained fields before;
    // an older cached client payload must not crash the page.
    const partial = [{ postCount: 0 } as ChannelStatLike];
    expect(deriveInsightsEmptyState(partial, false)).toBe("no_app_posts");
  });
});
