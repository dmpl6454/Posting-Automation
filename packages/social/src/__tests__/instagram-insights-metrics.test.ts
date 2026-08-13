import { describe, it, expect, vi, afterEach } from "vitest";
import { InstagramProvider } from "../providers/instagram.provider";

/**
 * Locks Instagram's per-media-product-type insight metric sets and the honesty
 * metadata derived from them.
 *
 * All metric names asserted here were verified INDIVIDUALLY against the live
 * production Graph API on 2026-08-06 with `instagram_manage_insights` granted.
 *
 * The single most important test is "never sends FEED-only metrics for a REEL":
 * Meta's /insights is ALL-OR-NOTHING, and `profile_visits` / `profile_activity` /
 * `follows` are NOT supported for REELS — unioning the sets makes the combined
 * REELS call fail outright and zeroes EVERY metric for that Reel. That is the
 * exact all-or-nothing regression PR #148 already had to fix once.
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
      return {
        ok,
        status: ok ? 200 : 400,
        json: async () => body,
        headers: { get: () => null },
      } as any;
    })
  );
  return calls;
}

/** Builds a Graph insights payload from a {name: value} map. */
const insightsBody = (metrics: Record<string, number>) => ({
  data: Object.entries(metrics).map(([name, value]) => ({
    name,
    period: "lifetime",
    values: [{ value }],
  })),
});

const media = (productType: string, extra: Record<string, unknown> = {}) => ({
  id: "MEDIA1",
  like_count: 0,
  comments_count: 0,
  media_product_type: productType,
  ...extra,
});

const tokens = { accessToken: "tok" };

afterEach(() => vi.unstubAllGlobals());

describe("Instagram getPostAnalytics — metric sets per media_product_type", () => {
  it("requests the FEED-only metrics for a FEED post", async () => {
    const calls = mockGraph((url) => {
      if (url.includes("/insights")) {
        return { ok: true, body: insightsBody({ reach: 5, views: 9, saved: 1, shares: 0 }) };
      }
      return { ok: true, body: media("FEED") };
    });

    await new InstagramProvider().getPostAnalytics(tokens, "MEDIA1");

    const insightsCall = calls.find((c) => c.url.includes("/insights"))!.url;
    expect(insightsCall).toContain("profile_visits");
    expect(insightsCall).toContain("profile_activity");
    expect(insightsCall).toContain("follows");
    // Reels-only metrics must not leak into a FEED request.
    expect(insightsCall).not.toContain("ig_reels_avg_watch_time");
  });

  it("NEVER sends the FEED-only metrics for a REEL (they 400 the whole call)", async () => {
    const calls = mockGraph((url) => {
      if (url.includes("/insights")) {
        return { ok: true, body: insightsBody({ reach: 106, views: 115, saved: 1 }) };
      }
      return { ok: true, body: media("REELS") };
    });

    await new InstagramProvider().getPostAnalytics(tokens, "MEDIA1");

    const insightsCall = calls.find((c) => c.url.includes("/insights"))!.url;
    expect(insightsCall).not.toContain("profile_visits");
    expect(insightsCall).not.toContain("profile_activity");
    expect(insightsCall).not.toContain("follows");
    expect(insightsCall).toContain("ig_reels_avg_watch_time");
    expect(insightsCall).toContain("ig_reels_video_view_total_time");
  });

  it("uses the STORY set (replies/navigation, no saved) for a STORY", async () => {
    const calls = mockGraph((url) => {
      if (url.includes("/insights")) return { ok: true, body: insightsBody({ reach: 3, views: 4 }) };
      return { ok: true, body: media("STORY") };
    });

    await new InstagramProvider().getPostAnalytics(tokens, "MEDIA1");

    const insightsCall = calls.find((c) => c.url.includes("/insights"))!.url;
    expect(insightsCall).toContain("replies");
    expect(insightsCall).toContain("navigation");
    expect(insightsCall).not.toContain("saved");
    expect(insightsCall).not.toContain("profile_visits");
  });

  it("falls back to the conservative base set for an unknown product type", async () => {
    // A future/unrecognized type must not receive type-specific metrics that it
    // might reject — that would fail the whole call.
    const calls = mockGraph((url) => {
      if (url.includes("/insights")) return { ok: true, body: insightsBody({ reach: 1, views: 1 }) };
      return { ok: true, body: media("AD") };
    });

    await new InstagramProvider().getPostAnalytics(tokens, "MEDIA1");
    const insightsCall = calls.find((c) => c.url.includes("/insights"))!.url;
    expect(insightsCall).not.toContain("profile_visits");
    expect(insightsCall).not.toContain("ig_reels");
    expect(insightsCall).toContain("total_interactions");
  });
});

describe("Instagram getPostAnalytics — real captured values", () => {
  it("maps a real Reel's metrics onto the snapshot slots", async () => {
    // Values captured live from Reel 17900362803522250.
    mockGraph((url) => {
      if (url.includes("/insights")) {
        return {
          ok: true,
          body: insightsBody({
            reach: 106,
            views: 115,
            saved: 1,
            shares: 0,
            total_interactions: 1,
            ig_reels_avg_watch_time: 3038,
            ig_reels_video_view_total_time: 328109,
          }),
        };
      }
      return { ok: true, body: media("REELS", { like_count: 0, comments_count: 0 }) };
    });

    const a = await new InstagramProvider().getPostAnalytics(tokens, "MEDIA1");

    expect(a).toBeTruthy();
    expect(a!.reach).toBe(106);
    // The number still lands in BOTH slots (the impressions column is retained so
    // historical rows and the engagement-rate denominator are unchanged) …
    expect(a!.impressions).toBe(115);
    expect(a!.views).toBe(115);
    expect(a!.saved).toBe(1);
    expect(a!.avgWatchTimeMs).toBe(3038);
    expect(a!.totalWatchTimeMs).toBe(328109);
    // ⚠️ … but `impressions` must be declared FALSE. Instagram has no impressions
    // metric (Meta deleted it in v22.0). Declaring it true — or merely OMITTING
    // the key, which reads as available — made the UI render Impressions and
    // Views as two columns holding the identical number, on 66,073 prod rows.
    // The static capability map alone cannot prevent that: per-capture
    // metricsAvailable OVERRIDES it at every consumer.
    expect(a!.metricsAvailable).toMatchObject({
      impressions: false,
      views: true,
      reach: true,
      shares: true,
      clicks: false, // IG has no click metric at all
    });
    expect(a!.degraded).toBeUndefined();
  });
});

describe("Instagram getPostAnalytics — honest availability (P2 regression)", () => {
  it("does NOT claim impressions/shares are available when only the reach retry succeeded", async () => {
    // Regression: the old `hasInsights = metrics.reach != null || impressions > 0`
    // was a single boolean for the whole call, so a partial success declared
    // impressions AND shares "available" while they were never returned —
    // reporting a confident 0 for data the platform never sent.
    let insightsCalls = 0;
    mockGraph((url) => {
      if (url.includes("/insights")) {
        insightsCalls++;
        // Full set and base set both fail; only the reach-only retry succeeds.
        if (url.includes("metric=reach&") || url.endsWith("metric=reach")) {
          return { ok: true, body: insightsBody({ reach: 42 }) };
        }
        return {
          ok: false,
          body: { error: { code: 100, message: "(#100) does not support the metric" } },
        };
      }
      return { ok: true, body: media("FEED") };
    });

    const a = await new InstagramProvider().getPostAnalytics(tokens, "MEDIA1");

    expect(a!.reach).toBe(42);
    expect(a!.metricsAvailable?.reach).toBe(true);
    // The honest part: never returned ⇒ not available ⇒ UI renders "—", not 0.
    expect(a!.metricsAvailable?.impressions).toBe(false);
    expect(a!.metricsAvailable?.shares).toBe(false);
    expect(a!.saved).toBeUndefined();
    // The ladder descended: preferred → base → reach.
    expect(insightsCalls).toBe(3);
  });

  it("reports a dead token as needing a reconnect instead of returning bare null", async () => {
    // The most common production failure: the token dies at the MEDIA read,
    // before insights are ever attempted. Returning null lost the diagnosis, so
    // the channel kept rendering zeros with no hint that it needed reconnecting.
    mockGraph(() => ({
      ok: false,
      body: {
        error: {
          code: 190,
          error_subcode: 460,
          message: "Error validating access token: The session has been invalidated",
        },
      },
    }));

    const a = await new InstagramProvider().getPostAnalytics(tokens, "MEDIA1");

    expect(a).toBeTruthy();
    expect(a!.degraded?.reason).toBe("token_invalid");
    // Every metric unavailable ⇒ the table renders "—" exactly as before.
    expect(a!.metricsAvailable).toMatchObject({
      impressions: false,
      reach: false,
      likes: false,
      comments: false,
      shares: false,
      clicks: false,
    });
  });

  it("still returns bare null for a non-actionable media-read failure", async () => {
    // A rate limit is not something the user can fix by reconnecting.
    mockGraph(() => ({
      ok: false,
      body: { error: { code: 4, message: "(#4) Application request limit reached" } },
    }));

    expect(await new InstagramProvider().getPostAnalytics(tokens, "MEDIA1")).toBeNull();
  });

  it("flags the silent-empty insights response as a missing scope", async () => {
    mockGraph((url) => {
      if (url.includes("/insights")) return { ok: true, body: { data: [] } };
      return { ok: true, body: media("FEED") };
    });

    const a = await new InstagramProvider().getPostAnalytics(tokens, "MEDIA1");

    expect(a!.degraded?.reason).toBe("missing_scope");
    expect(a!.degraded?.missingScopes).toContain("instagram_manage_insights");
    expect(a!.metricsAvailable?.impressions).toBe(false);
    expect(a!.metricsAvailable?.reach).toBe(false);
  });
});
