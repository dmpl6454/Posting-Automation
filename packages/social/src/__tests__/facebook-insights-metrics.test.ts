import { describe, it, expect, vi, afterEach } from "vitest";
import { FacebookProvider } from "../providers/facebook.provider";

vi.mock("@postautomation/social-scrapers", () => ({
  scrapeFacebookReelEngagement: vi.fn(async () => null),
}));

/**
 * Locks Facebook's insight capture semantics after the 2026-08-06 permission
 * approval. Every response shape below was captured from the live production
 * Graph API while probing with, and without, the newly-approved scopes.
 *
 * The headline behavior: a token missing `read_insights` gets HTTP **200 with an
 * empty `data` array** — a SILENT empty. Before this was handled, that was read
 * as "every metric is zero" and stored as a confident 0, making a dead or
 * under-scoped token indistinguishable from genuinely zero engagement.
 */

function mockGraph(handler: (url: string) => { ok: boolean; body: any }) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      const { ok, body } = handler(String(url));
      return {
        ok,
        status: ok ? 200 : 400,
        json: async () => body,
        clone: () => ({ json: async () => body }),
        headers: { get: () => null },
      } as any;
    })
  );
  return calls;
}

const insightsBody = (metrics: Record<string, unknown>) => ({
  data: Object.entries(metrics).map(([name, value]) => ({
    name,
    period: "lifetime",
    values: [{ value }],
  })),
});

const tokens = { accessToken: "tok" };
const FEED_ID = "1200847766436751_122122552605340772";
const VIDEO_ID = "1588139229514895";

afterEach(() => {
  vi.unstubAllGlobals();
  // The scraper mock is module-level, so its call history would otherwise leak
  // between tests — the #200 test legitimately DOES scrape, which would make the
  // "does not scrape" assertion below pass or fail depending on ordering.
  vi.clearAllMocks();
});

describe("Facebook feed-post insights — silent-empty detection (P1)", () => {
  it("marks clicks UNAVAILABLE when insights return 200 with zero rows", async () => {
    // VERIFIED live: this is exactly what a token without read_insights receives.
    mockGraph((url) => {
      if (url.includes("/insights")) return { ok: true, body: { data: [], paging: {} } };
      // fields also blocked, as it is for the same under-scoped token
      return {
        ok: false,
        body: { error: { code: 10, message: "(#10) This endpoint requires the 'pages_read_user_content' permission" } },
      };
    });

    const a = await new FacebookProvider().getPostAnalytics(tokens, FEED_ID);

    expect(a).toBeTruthy();
    // The whole point: NOT reported as an available zero.
    expect(a!.metricsAvailable?.clicks).toBe(false);
    expect(a!.metricsAvailable?.comments).toBe(false);
    expect(a!.metricsAvailable?.likes).toBe(false);
    expect(a!.degraded?.reason).toBe("missing_scope");
    // One reconnect fixes both blocked calls, so both scopes are named.
    expect(a!.degraded?.missingScopes).toEqual(["pages_read_user_content", "read_insights"]);
  });

  it("reports a genuine zero as AVAILABLE when insights return real rows", async () => {
    // A brand-new Page with fan_count 0 legitimately reports 0 for everything.
    // That must render as "0", not "—" — the inverse error of the case above.
    mockGraph((url) => {
      if (url.includes("/insights")) {
        return {
          ok: true,
          body: insightsBody({ post_clicks: 0, post_video_views: 0, post_reactions_by_type_total: {} }),
        };
      }
      return {
        ok: true,
        body: {
          shares: undefined,
          comments: { summary: { total_count: 0 } },
          reactions: { summary: { total_count: 0 } },
        },
      };
    });

    const a = await new FacebookProvider().getPostAnalytics(tokens, FEED_ID);

    expect(a!.clicks).toBe(0);
    expect(a!.metricsAvailable?.clicks).toBe(true);
    expect(a!.metricsAvailable?.comments).toBe(true);
    expect(a!.metricsAvailable?.likes).toBe(true);
    expect(a!.degraded).toBeUndefined();
  });

  it("keeps impressions and reach permanently unavailable", async () => {
    // Re-verified 2026-08-06 WITH read_insights granted: every post_impressions*
    // variant still returns #100 "must be a valid insights metric". Meta deleted
    // them; no permission restores them. Never render a fabricated number.
    const calls = mockGraph((url) => {
      if (url.includes("/insights")) {
        return { ok: true, body: insightsBody({ post_clicks: 3, post_reactions_by_type_total: { like: 2 } }) };
      }
      return { ok: true, body: { shares: { count: 1 }, comments: { summary: { total_count: 4 } } } };
    });

    const a = await new FacebookProvider().getPostAnalytics(tokens, FEED_ID);

    expect(a!.metricsAvailable?.impressions).toBe(false);
    expect(a!.metricsAvailable?.reach).toBe(false);
    // And we must never REQUEST a deleted metric — one invalid name 400s the
    // whole call, taking the valid metrics down with it.
    const insightsUrl = calls.find((c) => c.includes("/insights"))!;
    expect(insightsUrl).not.toContain("post_impressions");
    expect(insightsUrl).not.toContain("post_engaged_users");
  });

  it("sums post_reactions_by_type_total across reaction types", async () => {
    mockGraph((url) => {
      if (url.includes("/insights")) {
        return {
          ok: true,
          body: insightsBody({ post_clicks: 0, post_reactions_by_type_total: { like: 5, love: 2, haha: 1 } }),
        };
      }
      // fields blocked ⇒ falls back to the insights reaction total
      return { ok: false, body: { error: { code: 10, message: "requires the 'pages_read_user_content' permission" } } };
    });

    const a = await new FacebookProvider().getPostAnalytics(tokens, FEED_ID);
    expect(a!.likes).toBe(8);
    expect(a!.metricsAvailable?.likes).toBe(true);
  });
});

describe("Facebook video-post insights (P5)", () => {
  it("keeps real video views when only the FIELDS call fails", async () => {
    // Regression: the old code returned null on a fields failure, discarding
    // successfully-fetched video_insights — throwing away real view counts.
    mockGraph((url) => {
      if (url.includes("/video_insights")) {
        return { ok: true, body: insightsBody({ total_video_views: 4211, total_video_impressions: 5000 }) };
      }
      return {
        ok: false,
        body: { error: { code: 10, message: "(#10) This endpoint requires the 'pages_read_user_content' permission" } },
      };
    });

    const a = await new FacebookProvider().getPostAnalytics(tokens, VIDEO_ID);

    expect(a).toBeTruthy();
    expect(a!.impressions).toBe(5000);
    // The per-capture override that stops the platform-wide static map (which
    // marks FACEBOOK impressions unavailable for FEED posts) from hiding this.
    expect(a!.metricsAvailable?.impressions).toBe(true);
    expect(a!.metricsAvailable?.likes).toBe(false);
    expect(a!.degraded?.reason).toBe("missing_scope");
  });

  it("surfaces the loud #200 read_insights failure on the video edge", async () => {
    // Unlike the feed edge, video_insights fails LOUDLY when read_insights is
    // missing (verified: #200 "read_insights permission missing").
    mockGraph((url) => {
      if (url.includes("/video_insights")) {
        return { ok: false, body: { error: { code: 200, message: "(#200) read_insights permission missing" } } };
      }
      return { ok: true, body: { likes: { summary: { total_count: 7 } }, comments: { summary: { total_count: 2 } } } };
    });

    const a = await new FacebookProvider().getPostAnalytics(tokens, VIDEO_ID);

    expect(a!.degraded?.reason).toBe("missing_scope");
    expect(a!.degraded?.missingScopes).toContain("read_insights");
    expect(a!.metricsAvailable?.impressions).toBe(false);
    // Engagement from the fields call is still real and still reported.
    expect(a!.likes).toBe(7);
    expect(a!.metricsAvailable?.likes).toBe(true);
  });

  it("does not scrape when the API legitimately reports zero views", async () => {
    // Scraping a genuinely-zero-view video wastes a request and can overwrite a
    // true 0 with a stale public number.
    const { scrapeFacebookReelEngagement } = await import("@postautomation/social-scrapers");
    mockGraph((url) => {
      if (url.includes("/video_insights")) {
        return { ok: true, body: insightsBody({ total_video_views: 0, total_video_impressions: 0 }) };
      }
      return { ok: true, body: { likes: { summary: { total_count: 0 } }, comments: { summary: { total_count: 0 } } } };
    });

    const a = await new FacebookProvider().getPostAnalytics(tokens, VIDEO_ID);

    expect(a!.impressions).toBe(0);
    expect(a!.metricsAvailable?.impressions).toBe(true); // a real, captured 0
    expect(scrapeFacebookReelEngagement).not.toHaveBeenCalled();
  });
});
