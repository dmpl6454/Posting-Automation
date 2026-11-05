import { describe, it, expect, vi, afterEach } from "vitest";
import { InstagramProvider } from "../providers/instagram.provider";
import { diagnoseMetaError } from "../utils/meta-insight-diagnosis";

/**
 * Honesty rules for STORY captures (2026-09-15).
 *
 * A story has no like or comment surface, and a story with fewer than five
 * viewers is a normal small account — not a broken channel. Both mistakes
 * produce the same visible symptom this codebase keeps fixing: a confident
 * number (or a reconnect banner) where the truth is "not reported".
 */

interface FakeCall {
  url: string;
}

function mockGraph(handler: (url: string) => { ok: boolean; body: any }) {
  const calls: FakeCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push({ url: String(url) });
      const { ok, body } = handler(String(url));
      return { ok, status: ok ? 200 : 400, json: async () => body, headers: { get: () => null } } as any;
    })
  );
  return calls;
}

const insightsBody = (metrics: Record<string, number>) => ({
  data: Object.entries(metrics).map(([name, value]) => ({ name, period: "lifetime", values: [{ value }] })),
});

const tokens = { accessToken: "tok" };

afterEach(() => vi.unstubAllGlobals());

describe("Instagram STORY analytics", () => {
  it("requests the STORY metric set and never the FEED/REELS-only names", async () => {
    const calls = mockGraph((url) => {
      if (url.includes("/insights")) {
        return { ok: true, body: insightsBody({ reach: 12, views: 20, shares: 1, total_interactions: 2, replies: 1, navigation: 3 }) };
      }
      return { ok: true, body: { id: "S1", like_count: 0, comments_count: 0, media_product_type: "STORY" } };
    });

    await new InstagramProvider().getPostAnalytics(tokens, "S1");

    const insights = calls.find((c) => c.url.includes("/insights"))!.url;
    expect(insights).toContain("replies");
    expect(insights).toContain("navigation");
    // All-or-nothing: one unsupported name fails the WHOLE call and zeroes it.
    expect(insights).not.toContain("saved");
    expect(insights).not.toContain("profile_visits");
    expect(insights).not.toContain("ig_reels_avg_watch_time");
  });

  it("declares likes/comments/saved UNAVAILABLE so a story never prints a fake 0", async () => {
    mockGraph((url) => {
      if (url.includes("/insights")) return { ok: true, body: insightsBody({ reach: 12, views: 20, shares: 0 }) };
      return { ok: true, body: { id: "S1", like_count: 0, comments_count: 0, media_product_type: "STORY" } };
    });

    const a = await new InstagramProvider().getPostAnalytics(tokens, "S1");

    // Omitting a key reads as AVAILABLE at every consumer — these must be explicit.
    expect(a?.metricsAvailable?.likes).toBe(false);
    expect(a?.metricsAvailable?.comments).toBe(false);
    expect((a?.metricsAvailable as Record<string, boolean>)?.saved).toBe(false);
    // The metrics a story DOES report stay available.
    expect(a?.metricsAvailable?.reach).toBe(true);
    expect(a?.metricsAvailable?.views).toBe(true);
  });

  it("leaves a REELS capture's availability untouched (likes/comments still omitted)", async () => {
    mockGraph((url) => {
      if (url.includes("/insights")) {
        return { ok: true, body: insightsBody({ reach: 5, views: 9, saved: 1, shares: 0, likes: 2, comments: 1, total_interactions: 3 }) };
      }
      return { ok: true, body: { id: "R1", like_count: 2, comments_count: 1, media_product_type: "REELS" } };
    });

    const a = await new InstagramProvider().getPostAnalytics(tokens, "R1");
    expect(a?.metricsAvailable).not.toHaveProperty("likes");
    expect(a?.metricsAvailable).not.toHaveProperty("comments");
  });

  it("does not descend to the BASE_SET rung for a story — that call is a certain #100", async () => {
    let insightCalls = 0;
    mockGraph((url) => {
      if (url.includes("/insights")) {
        insightCalls++;
        return { ok: false, body: { error: { code: 100, message: "(#100) must be a valid insights metric" } } };
      }
      return { ok: true, body: { id: "S1", like_count: 0, comments_count: 0, media_product_type: "STORY" } };
    });

    await new InstagramProvider().getPostAnalytics(tokens, "S1");
    // preferred (STORY set) → reach. Never the likes/comments/saved rung.
    expect(insightCalls).toBe(2);
  });
});

describe("diagnoseMetaError — a quiet story is not a broken channel", () => {
  it("#10 'Not enough viewers' is NOT a missing scope", () => {
    // Every small account's stories would otherwise raise a reconnect banner for
    // data that no permission can produce.
    expect(
      diagnoseMetaError({ code: 10, message: "(#10) Not enough viewers for the media to show insights" })
    ).toBeUndefined();
  });

  it("a genuine #10 permission error is still an actionable missing scope", () => {
    const d = diagnoseMetaError({
      code: 10,
      message: "(#10) This endpoint requires the 'pages_read_user_content' permission or the 'Page Public Content Access' feature.",
    });
    expect(d?.reason).toBe("missing_scope");
    expect(d?.missingScopes).toContain("pages_read_user_content");
  });
});

describe("Instagram STORY extras — taps, exits, profile actions (2026-11-05)", () => {
  const storyMedia = { id: "S1", like_count: 0, comments_count: 0, media_product_type: "STORY" };
  // Verbatim shape of Meta's documented breakdown response (values come back lower case).
  const navBreakdown = {
    data: [
      {
        name: "navigation",
        period: "lifetime",
        total_value: {
          value: 31,
          breakdowns: [
            {
              dimension_keys: ["story_navigation_action_type"],
              results: [
                { dimension_values: ["tap_forward"], value: 20 },
                { dimension_values: ["tap_back"], value: 3 },
                { dimension_values: ["tap_exit"], value: 6 },
                { dimension_values: ["swipe_forward"], value: 2 },
              ],
            },
          ],
        },
      },
    ],
  };

  it("keeps replies/navigation and adds the breakdown + profile metrics from two separate calls", async () => {
    const calls = mockGraph((url) => {
      if (url.includes("breakdown=story_navigation_action_type")) return { ok: true, body: navBreakdown };
      if (url.includes("metric=profile_visits")) {
        return { ok: true, body: insightsBody({ profile_visits: 4, follows: 1, link_clicks: 2 }) };
      }
      if (url.includes("/insights")) {
        return { ok: true, body: insightsBody({ reach: 12, views: 20, shares: 1, total_interactions: 5, replies: 2, navigation: 31 }) };
      }
      return { ok: true, body: storyMedia };
    });

    const a = await new InstagramProvider().getPostAnalytics(tokens, "S1");

    expect(a?.story).toEqual({
      replies: 2,
      navigation: 31,
      totalInteractions: 5,
      tapsForward: 20,
      tapsBack: 3,
      exits: 6,
      swipeForward: 2,
      profileVisits: 4,
      follows: 1,
      linkClicks: 2,
    });
    // The breakdown is NEVER mixed into the core metric call (Meta warns that
    // combining a breakdown with an unsupported metric is an unknown error).
    const core = calls.filter((c) => c.url.includes("/insights"))[0]!.url;
    expect(core).not.toContain("breakdown");
    expect(core).not.toContain("profile_visits");
    // The core numbers are unchanged.
    expect(a?.views).toBe(20);
    expect(a?.reach).toBe(12);
  });

  it("a failing extra costs only that extra — never the core numbers, never a throw", async () => {
    mockGraph((url) => {
      if (url.includes("breakdown=")) return { ok: false, body: { error: { code: 1, message: "An unknown error has occurred." } } };
      if (url.includes("metric=profile_visits")) return { ok: false, body: { error: { code: 100, message: "(#100) bad metric" } } };
      if (url.includes("/insights")) return { ok: true, body: insightsBody({ reach: 9, views: 11, shares: 0, replies: 0, navigation: 4 }) };
      return { ok: true, body: storyMedia };
    });

    const a = await new InstagramProvider().getPostAnalytics(tokens, "S1");
    expect(a?.views).toBe(11);
    expect(a?.story).toEqual({ replies: 0, navigation: 4 });
    expect(a?.degraded).toBeUndefined();
  });

  it("flags 'not enough viewers' and makes no extra calls after the core set failed", async () => {
    const calls = mockGraph((url) => {
      if (url.includes("/insights")) {
        return { ok: false, body: { error: { code: 10, message: "(#10) Not enough viewers for the media to show insights" } } };
      }
      return { ok: true, body: storyMedia };
    });

    const a = await new InstagramProvider().getPostAnalytics(tokens, "S1");
    expect(a?.story).toEqual({ notEnoughViewers: true });
    // STORY set → reach rung. No breakdown / profile reads on a story Meta just refused.
    expect(calls.filter((c) => c.url.includes("/insights"))).toHaveLength(2);
    // A quiet story is not a broken channel.
    expect(a?.degraded).toBeUndefined();
  });

  it("FEED and REELS captures carry no story field (byte-identical to before)", async () => {
    for (const productType of ["FEED", "REELS"]) {
      const calls = mockGraph((url) => {
        if (url.includes("/insights")) return { ok: true, body: insightsBody({ reach: 5, views: 9, saved: 1, shares: 0, likes: 2, comments: 1, total_interactions: 3 }) };
        return { ok: true, body: { id: "X", like_count: 2, comments_count: 1, media_product_type: productType } };
      });
      const a = await new InstagramProvider().getPostAnalytics(tokens, "X");
      expect(a).not.toHaveProperty("story");
      expect(calls.filter((c) => c.url.includes("/insights"))).toHaveLength(1);
      vi.unstubAllGlobals();
    }
  });
});
