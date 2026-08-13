import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FacebookProvider } from "../providers/facebook.provider";

/**
 * `post_video_views` — a QUALIFIED view count, genuinely different from
 * `post_media_view` (renders/plays).
 *
 * LIVE-MEASURED on prod 2026-08-12, same reel, same call:
 *   post_media_view              5,063   (matches the Video node's fb_reels_total_plays 5,069)
 *   post_total_media_view_unique 4,574
 *   post_video_views             1,468   <- 3.45x smaller
 *
 * ⚠️ The metric was requested on EVERY production call from the day
 * FB_INSIGHT_METRICS_BASE was written, and never read. The code carried a
 * comment asserting it "returns post_video_views = 0 for every video (measured
 * 40/40)" — which was the last-wins parse reading its trailing `period=day` row.
 * A measurement taken through a known-buggy parser is not evidence about the
 * API, and that comment is what kept a working metric unwired for months.
 */
const tokens = { accessToken: "T" } as any;
const POST = "111_222";

/** Production row shape: a real lifetime value AND a trailing zero `day` row. */
const REEL_INSIGHTS = {
  data: [
    { name: "post_clicks", period: "lifetime", values: [{ value: 3 }] },
    { name: "post_video_views", period: "lifetime", values: [{ value: 1468 }] },
    { name: "post_reactions_by_type_total", period: "lifetime", values: [{ value: { like: 1 } }] },
    { name: "post_media_view", period: "lifetime", values: [{ value: 5063 }] },
    { name: "post_total_media_view_unique", period: "lifetime", values: [{ value: 4574 }] },
    // The trap: zero-valued, stale, and LAST.
    { name: "post_video_views", period: "day", values: [{ value: 0, end_time: "2026-08-09" }] },
    { name: "post_total_media_view_unique", period: "day", values: [{ value: 0 }] },
  ],
};

const FIELDS_OK = {
  shares: { count: 2 },
  comments: { summary: { total_count: 4 } },
  reactions: { summary: { total_count: 9 } },
};

const ok = (body: any) => ({ ok: true, status: 200, json: async () => body });

function installFetch(handler: (url: string) => any) {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any) => {
      const u = String(url);
      seen.push(u);
      const r = handler(u);
      if (!r) throw new Error(`unexpected fetch: ${u}`);
      return r as any;
    })
  );
  return seen;
}

describe("Facebook views — post_video_views is read, and is NOT impressions", () => {
  beforeEach(() => {
    process.env.FB_MEDIA_VIEW_METRICS_ENABLED = "true";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FB_MEDIA_VIEW_METRICS_ENABLED;
  });

  it("🔴 reads the LIFETIME value, not the trailing zero day row", async () => {
    installFetch((u) => (u.includes("/insights?metric=") ? ok(REEL_INSIGHTS) : ok(FIELDS_OK)));
    const a = (await new FacebookProvider().getPostAnalytics(tokens, POST))!;
    // 1,468 — the real figure. A last-wins parse would store 0 here, which is
    // exactly the "measured 40/40 zeros" that stopped this metric being wired up.
    expect(a.views).toBe(1468);
  });

  it("🔴 keeps views DISTINCT from impressions — conflating them misreports 3.45x", async () => {
    installFetch((u) => (u.includes("/insights?metric=") ? ok(REEL_INSIGHTS) : ok(FIELDS_OK)));
    const a = (await new FacebookProvider().getPostAnalytics(tokens, POST))!;
    expect(a.impressions).toBe(5063); // post_media_view — renders/plays
    expect(a.views).toBe(1468); // post_video_views — qualified views
    expect(a.views).not.toBe(a.impressions);
  });

  it("declares views available when a trusted row came back", async () => {
    installFetch((u) => (u.includes("/insights?metric=") ? ok(REEL_INSIGHTS) : ok(FIELDS_OK)));
    const a = (await new FacebookProvider().getPostAnalytics(tokens, POST))!;
    expect(a.metricsAvailable?.views).toBe(true);
  });

  it("a measured ZERO stays a real 0 and stays available (a photo has 0 video views)", async () => {
    // Live-probed on an album post: post_video_views returns lifetime 0 — a real
    // measurement, not an absence. It must not become "—".
    const zero = {
      data: [
        { name: "post_clicks", period: "lifetime", values: [{ value: 330 }] },
        { name: "post_video_views", period: "lifetime", values: [{ value: 0 }] },
        { name: "post_media_view", period: "lifetime", values: [{ value: 40587 }] },
      ],
    };
    installFetch((u) => (u.includes("/insights?metric=") ? ok(zero) : ok(FIELDS_OK)));
    const a = (await new FacebookProvider().getPostAnalytics(tokens, POST))!;
    expect(a.views).toBe(0);
    expect(a.metricsAvailable?.views).toBe(true);
  });

  it("🔴 a DAY-ONLY response is not trusted — no fabricated zero", async () => {
    // The confident-zero signature: presentMetricNames would say "available"
    // while the value resolves to the day bucket's 0.
    const dayOnly = {
      data: [
        { name: "post_clicks", period: "lifetime", values: [{ value: 3 }] },
        { name: "post_video_views", period: "day", values: [{ value: 0, end_time: "2026-08-09" }] },
      ],
    };
    installFetch((u) => (u.includes("/insights?metric=") ? ok(dayOnly) : ok(FIELDS_OK)));
    const a = (await new FacebookProvider().getPostAnalytics(tokens, POST))!;
    expect(a.metricsAvailable?.views).toBe(false);
  });

  it("omits views entirely when the insights call was unusable — never 0", async () => {
    // HTTP 200 with zero rows is the missing-scope sentinel.
    installFetch((u) => (u.includes("/insights?metric=") ? ok({ data: [] }) : ok(FIELDS_OK)));
    const a = (await new FacebookProvider().getPostAnalytics(tokens, POST))!;
    expect(a.views).toBeUndefined();
    expect(a.metricsAvailable?.views).toBe(false);
  });

  it("costs no extra round-trip — the metric was already in every request", async () => {
    const seen = installFetch((u) =>
      u.includes("/insights?metric=") ? ok(REEL_INSIGHTS) : ok(FIELDS_OK)
    );
    await new FacebookProvider().getPostAnalytics(tokens, POST);
    expect(seen.filter((u) => u.includes("/insights?metric=")).length).toBe(1);
    expect(seen.some((u) => u.includes("post_video_views"))).toBe(true);
  });
});
