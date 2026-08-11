import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FacebookProvider } from "../providers/facebook.provider";

/**
 * The two-rung media-view ladder, with the flag ON.
 *
 * Locks the behaviours the design review identified as unsafe if wrong:
 *  - the LIFETIME row wins over the trailing zero-valued `day` duplicate
 *  - a metric-NAME rejection descends exactly once and preserves clicks/likes
 *  - a 200-with-zero-rows does NOT descend (it is the missing-scope sentinel)
 *    and still reports missing_scope after the ladder runs (critic gap P0-2)
 *  - a hard error (190/10) never descends
 *  - all six metricsAvailable keys are always present
 */

const tokens = { accessToken: "T" } as any;
const POST = "111_222";

/** The exact 7-row production response (5 metrics, 2 stale `day` duplicates). */
const PROD_INSIGHTS = {
  data: [
    { name: "post_clicks", period: "lifetime", values: [{ value: 3 }] },
    { name: "post_video_views", period: "lifetime", values: [{ value: 0 }] },
    { name: "post_reactions_by_type_total", period: "lifetime", values: [{ value: { like: 1 } }] },
    { name: "post_media_view", period: "lifetime", values: [{ value: 144 }] },
    { name: "post_total_media_view_unique", period: "lifetime", values: [{ value: 106 }] },
    { name: "post_video_views", period: "day", values: [{ value: 0 }] },
    { name: "post_total_media_view_unique", period: "day", values: [{ value: 0 }] },
  ],
};

const BASE_INSIGHTS = {
  data: [
    { name: "post_clicks", period: "lifetime", values: [{ value: 3 }] },
    { name: "post_video_views", period: "lifetime", values: [{ value: 0 }] },
    { name: "post_reactions_by_type_total", period: "lifetime", values: [{ value: { like: 1 } }] },
  ],
};

const FIELDS_OK = { shares: { count: 2 }, comments: { summary: { total_count: 4 } }, reactions: { summary: { total_count: 9 } } };

const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });
const bad = (body: any, status = 400) => ({ ok: false, status, json: async () => body });

const NAME_ERROR = { error: { code: 100, message: "(#100) The value must be a valid insights metric" } };

function installFetch(handler: (url: string) => any) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any) => {
    const u = String(url);
    seen.push(u);
    const r = handler(u);
    if (!r) throw new Error(`unexpected fetch: ${u}`);
    return r as any;
  }));
  return seen;
}

describe("FB media-view ladder (FB_MEDIA_VIEW_METRICS_ENABLED=true)", () => {
  beforeEach(() => {
    process.env.FB_MEDIA_VIEW_METRICS_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.FB_MEDIA_VIEW_METRICS_ENABLED;
    vi.unstubAllGlobals();
  });

  it("requests both new names on rung 1, appended after the base list", async () => {
    const seen = installFetch((u) =>
      u.includes("/insights?metric=") ? ok(PROD_INSIGHTS) : ok(FIELDS_OK)
    );
    await new FacebookProvider().getPostAnalytics(tokens, POST);
    const insights = seen.find((u) => u.includes("/insights?metric="))!;
    expect(insights).toContain("metric=post_clicks,post_video_views,post_reactions_by_type_total,post_media_view,post_total_media_view_unique");
  });

  it("🔴 reads the LIFETIME rows — the trailing day duplicate must not zero reach", async () => {
    installFetch((u) => (u.includes("/insights?metric=") ? ok(PROD_INSIGHTS) : ok(FIELDS_OK)));
    const a = (await new FacebookProvider().getPostAnalytics(tokens, POST))!;
    expect(a.impressions).toBe(144);
    expect(a.reach).toBe(106); // would be 0 under a last-wins parse
    expect(a.metricsAvailable).toMatchObject({ impressions: true, reach: true });
    expect(a.reachIsDistinct).toBe(true);
  });

  it("makes exactly ONE insights call on the happy path (no extra round-trip)", async () => {
    const seen = installFetch((u) => (u.includes("/insights?metric=") ? ok(PROD_INSIGHTS) : ok(FIELDS_OK)));
    await new FacebookProvider().getPostAnalytics(tokens, POST);
    expect(seen.filter((u) => u.includes("/insights?metric=")).length).toBe(1);
  });

  it("descends ONCE on a metric-name error and preserves clicks + likes", async () => {
    let call = 0;
    const seen = installFetch((u) => {
      if (u.includes("/insights?metric=")) {
        call++;
        return call === 1 ? bad(NAME_ERROR) : ok(BASE_INSIGHTS);
      }
      return ok(FIELDS_OK);
    });
    const a = (await new FacebookProvider().getPostAnalytics(tokens, POST))!;
    const insightsCalls = seen.filter((u) => u.includes("/insights?metric="));
    expect(insightsCalls.length).toBe(2);
    // rung 2 is byte-identical to the pre-change call
    expect(insightsCalls[1]).toContain("metric=post_clicks,post_video_views,post_reactions_by_type_total&");
    expect(insightsCalls[1]).not.toContain("post_media_view");
    // the core metrics survive the descent — the whole point of the ladder
    expect(a.clicks).toBe(3);
    expect(a.likes).toBe(9);
    // and the new metrics correctly render "—", not a fake 0
    expect(a.metricsAvailable).toMatchObject({ impressions: false, reach: false, clicks: true });
  });

  it("🔴 does NOT descend on HTTP 200 with zero rows, and still reports missing_scope", async () => {
    // The under-scoped sentinel. Descending would double every under-scoped
    // channel's calls for nothing AND could mask the verdict (critic gap P0-2).
    const seen = installFetch((u) =>
      u.includes("/insights?metric=") ? ok({ data: [] }) : ok(FIELDS_OK)
    );
    const a = (await new FacebookProvider().getPostAnalytics(tokens, POST))!;
    expect(seen.filter((u) => u.includes("/insights?metric=")).length).toBe(1);
    expect(a.degraded?.reason).toBe("missing_scope");
    expect(a.degraded?.missingScopes).toEqual(["read_insights"]);
    expect(a.metricsAvailable).toMatchObject({ impressions: false, reach: false, clicks: false });
  });

  it("does NOT descend on a token error (a shorter metric list cannot fix 190)", async () => {
    const seen = installFetch((u) =>
      u.includes("/insights?metric=")
        ? bad({ error: { code: 190, error_subcode: 460, message: "session invalidated" } })
        : bad({ error: { code: 190, message: "session invalidated" } })
    );
    const a = (await new FacebookProvider().getPostAnalytics(tokens, POST))!;
    expect(seen.filter((u) => u.includes("/insights?metric=")).length).toBe(1);
    expect(a.degraded?.reason).toBeDefined();
  });

  it("does NOT descend on #100 subcode 33 (object not found, not a bad name)", async () => {
    const seen = installFetch((u) =>
      u.includes("/insights?metric=")
        ? bad({ error: { code: 100, error_subcode: 33, message: "Object with ID does not exist" } })
        : ok(FIELDS_OK)
    );
    await new FacebookProvider().getPostAnalytics(tokens, POST);
    expect(seen.filter((u) => u.includes("/insights?metric=")).length).toBe(1);
  });

  it("always declares all six metricsAvailable keys", async () => {
    installFetch((u) => (u.includes("/insights?metric=") ? ok(PROD_INSIGHTS) : ok(FIELDS_OK)));
    const a = (await new FacebookProvider().getPostAnalytics(tokens, POST))!;
    expect(Object.keys(a.metricsAvailable!).sort()).toEqual(
      ["clicks", "comments", "impressions", "likes", "reach", "shares"].sort()
    );
  });

  it("a present zero is declared AVAILABLE (measured 0 is a fact, not a gap)", async () => {
    installFetch((u) =>
      u.includes("/insights?metric=")
        ? ok({
            data: [
              { name: "post_clicks", period: "lifetime", values: [{ value: 0 }] },
              { name: "post_media_view", period: "lifetime", values: [{ value: 0 }] },
              { name: "post_total_media_view_unique", period: "lifetime", values: [{ value: 0 }] },
            ],
          })
        : ok(FIELDS_OK)
    );
    const a = (await new FacebookProvider().getPostAnalytics(tokens, POST))!;
    expect(a.impressions).toBe(0);
    expect(a.metricsAvailable).toMatchObject({ impressions: true, reach: true });
  });
});

describe("FB media-view ladder — flag OFF is byte-identical to before", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests only the base metrics and declares impressions/reach unavailable", async () => {
    delete process.env.FB_MEDIA_VIEW_METRICS_ENABLED;
    const seen = installFetch((u) =>
      u.includes("/insights?metric=") ? ok(BASE_INSIGHTS) : ok(FIELDS_OK)
    );
    const a = (await new FacebookProvider().getPostAnalytics(tokens, POST))!;
    const insights = seen.find((u) => u.includes("/insights?metric="))!;
    expect(insights).toContain("metric=post_clicks,post_video_views,post_reactions_by_type_total&");
    expect(insights).not.toContain("post_media_view");
    expect(a.impressions).toBe(0);
    expect(a.reach).toBe(0);
    expect(a.metricsAvailable).toMatchObject({ impressions: false, reach: false });
    expect(a.reachIsDistinct).toBe(false);
  });

  it("an EMPTY string (unplumbed compose var) also stays OFF — fail closed", async () => {
    process.env.FB_MEDIA_VIEW_METRICS_ENABLED = "";
    const seen = installFetch((u) =>
      u.includes("/insights?metric=") ? ok(BASE_INSIGHTS) : ok(FIELDS_OK)
    );
    await new FacebookProvider().getPostAnalytics(tokens, POST);
    expect(seen.find((u) => u.includes("/insights?metric="))!).not.toContain("post_media_view");
    delete process.env.FB_MEDIA_VIEW_METRICS_ENABLED;
  });
});
