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

  /**
   * ⚠️ REVERSED 2026-08-13, within hours of shipping — this originally asserted
   * that a measured 0 "stays a real 0 and stays available", on the principle that
   * a measured zero is a fact.
   *
   * That principle is right in general and wrong for THIS metric.
   * `post_video_views` is a VIDEO-only quantity: Meta genuinely returns lifetime 0
   * for a photo or album (live-probed on prod: album 113064544342606_1102601375432493
   * returned post_video_views=0 alongside post_media_view=274,053). Storing it is
   * therefore not a fabricated zero — but within one recapture sweep **750
   * non-video rows** had stored 0 and declared it available, and one Facebook
   * channel already rendered a channel-level "Views 0". A user reads that as
   * "nobody watched", not "there was nothing to watch".
   *
   * Accepted cost: a genuinely 0-view VIDEO now renders "—" instead of 0. That is
   * the conservative direction — "unknown" rather than a misleading zero.
   */
  it("a zero video-view count is SUPPRESSED — a photo must not report 'Views 0'", async () => {
    const zero = {
      data: [
        { name: "post_clicks", period: "lifetime", values: [{ value: 330 }] },
        { name: "post_video_views", period: "lifetime", values: [{ value: 0 }] },
        { name: "post_media_view", period: "lifetime", values: [{ value: 40587 }] },
      ],
    };
    installFetch((u) => (u.includes("/insights?metric=") ? ok(zero) : ok(FIELDS_OK)));
    const a = (await new FacebookProvider().getPostAnalytics(tokens, POST))!;
    expect(a.views).toBeUndefined();
    expect(a.metricsAvailable?.views).toBe(false);
    // The post's real delivery number is unaffected.
    expect(a.impressions).toBe(40587);
  });

  it("the stored value and its declaration never disagree", async () => {
    // A declaration that says "available" beside a NULL column (or vice versa) is
    // the exact shape of every fabricated-zero bug in this subsystem.
    for (const rows of [
      [{ name: "post_video_views", period: "lifetime", values: [{ value: 1468 }] }],
      [{ name: "post_video_views", period: "lifetime", values: [{ value: 0 }] }],
      [{ name: "post_video_views", period: "day", values: [{ value: 0 }] }],
      [{ name: "post_clicks", period: "lifetime", values: [{ value: 1 }] }],
    ]) {
      installFetch((u) => (u.includes("/insights?metric=") ? ok({ data: rows }) : ok(FIELDS_OK)));
      const a = (await new FacebookProvider().getPostAnalytics(tokens, POST))!;
      expect(a.metricsAvailable?.views).toBe(a.views !== undefined);
    }
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
