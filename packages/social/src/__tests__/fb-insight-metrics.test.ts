import { describe, it, expect } from "vitest";
import {
  FB_METRIC_IMPRESSIONS,
  FB_METRIC_REACH,
  FB_INSIGHT_METRICS_BASE,
  FB_INSIGHT_METRICS_PREFERRED,
  fbMetricParam,
  selectLifetimeRow,
  readMetricValue,
  presentMetricNames,
  hasTrustedValue,
  classifyFbRung,
  isFbMediaViewEnabled,
  type FbInsightRow,
} from "../utils/fb-insight-metrics";

/**
 * The exact production response shape, captured 2026-08-11 from
 * /{composite}/insights?metric=post_clicks,post_video_views,
 * post_reactions_by_type_total,post_media_view,post_total_media_view_unique
 *
 * 7 rows for 5 requested metrics: Meta appends `day`-period duplicates for two
 * of them, valued 0, AFTER the lifetime rows.
 */
const PROD_ROWS = [
  { name: "post_clicks", period: "lifetime", values: [{ value: 3 }] },
  { name: "post_video_views", period: "lifetime", values: [{ value: 0 }] },
  { name: "post_reactions_by_type_total", period: "lifetime", values: [{ value: { like: 1 } }] },
  { name: "post_media_view", period: "lifetime", values: [{ value: 144 }] },
  { name: "post_total_media_view_unique", period: "lifetime", values: [{ value: 106 }] },
  // ⬇⬇ the traps: duplicates, zero-valued, LAST
  { name: "post_video_views", period: "day", values: [{ value: 0, end_time: "2026-08-07T07:00:00+0000" }, { value: 0 }] },
  { name: "post_total_media_view_unique", period: "day", values: [{ value: 0, end_time: "2026-08-07T07:00:00+0000" }, { value: 0 }] },
];

describe("metric names", () => {
  it("uses the two live-verified names, spelled exactly", () => {
    // Regression guard: the near-miss spellings are all DEAD (#100) on prod.
    expect(FB_METRIC_IMPRESSIONS).toBe("post_media_view");
    expect(FB_METRIC_REACH).toBe("post_total_media_view_unique");
    expect(FB_METRIC_IMPRESSIONS).not.toBe("post_media_views");
    expect(FB_METRIC_REACH).not.toBe("post_total_media_view"); // dead without _unique
    expect(FB_METRIC_REACH).not.toBe("post_media_view_unique"); // dead spelling
  });

  it("never requests a metric Meta deleted — one bad name 400s the whole call", () => {
    const param = fbMetricParam(FB_INSIGHT_METRICS_PREFERRED);
    for (const dead of [
      "post_impressions",
      "post_impressions_unique",
      "post_impressions_organic",
      "post_impressions_paid",
      "post_impressions_fan",
      "post_reach",
      "post_engaged_users",
      "post_clicks_unique",
      "post_views",
      "post_negative_feedback",
      "post_engagements", // returns EMPTY200 — a silent empty, unusable
    ]) {
      expect(param.split(",")).not.toContain(dead);
    }
  });

  it("APPENDS the new names so the frozen-network-shape locks still match by prefix", () => {
    const preferred = fbMetricParam(FB_INSIGHT_METRICS_PREFERRED);
    const base = fbMetricParam(FB_INSIGHT_METRICS_BASE);
    // facebook-video.test.ts asserts toContain(`...?metric=${base}`)
    expect(preferred.startsWith(base)).toBe(true);
    // the strict mock in facebook-external-video-analytics.test.ts routes on this
    expect(preferred.startsWith("post_clicks")).toBe(true);
  });

  it("rung 2 is byte-identical to the pre-change call", () => {
    expect(fbMetricParam(FB_INSIGHT_METRICS_BASE)).toBe(
      "post_clicks,post_video_views,post_reactions_by_type_total"
    );
  });
});

describe("selectLifetimeRow / readMetricValue — the fake-zero trap", () => {
  it("🔴 picks the LIFETIME row, not the trailing day row (would store reach=0)", () => {
    // This is the assertion that fails against a last-wins parse.
    expect(readMetricValue(PROD_ROWS, FB_METRIC_REACH)).toBe(106);
    expect(selectLifetimeRow(PROD_ROWS, FB_METRIC_REACH)?.period).toBe("lifetime");
  });

  it("a naive last-wins parse would have read 0 — documents what we avoid", () => {
    const naive: Record<string, unknown> = {};
    for (const r of PROD_ROWS) naive[r.name!] = r.values?.[0]?.value;
    expect(naive[FB_METRIC_REACH]).toBe(0); // the bug
    expect(readMetricValue(PROD_ROWS, FB_METRIC_REACH)).toBe(106); // the fix
  });

  it("reads impressions and preserves impressions >= reach", () => {
    const impr = readMetricValue(PROD_ROWS, FB_METRIC_IMPRESSIONS)!;
    const reach = readMetricValue(PROD_ROWS, FB_METRIC_REACH)!;
    expect(impr).toBe(144);
    expect(impr).toBeGreaterThanOrEqual(reach);
  });

  it("sums object-valued reaction metrics", () => {
    expect(readMetricValue(PROD_ROWS, "post_reactions_by_type_total")).toBe(1);
    expect(
      readMetricValue(
        [{ name: "post_reactions_by_type_total", period: "lifetime", values: [{ value: { like: 2, love: 3, wow: 1 } }] }],
        "post_reactions_by_type_total"
      )
    ).toBe(6);
  });

  it("distinguishes ABSENT (null) from a present zero", () => {
    expect(readMetricValue(PROD_ROWS, "post_media_view_unique")).toBeNull(); // never returned
    expect(readMetricValue(PROD_ROWS, "post_video_views")).toBe(0); // present, really 0
  });

  it("falls back to the first row when no lifetime row exists", () => {
    const rows = [{ name: "x", period: "day", values: [{ value: 7 }] }];
    expect(readMetricValue(rows, "x")).toBe(7);
  });

  it("presentMetricNames reports what came back, deduping periods", () => {
    const present = presentMetricNames(PROD_ROWS);
    expect(present.has(FB_METRIC_IMPRESSIONS)).toBe(true);
    expect(present.has(FB_METRIC_REACH)).toBe(true);
    expect(present.has("post_impressions")).toBe(false);
    expect(present.size).toBe(5); // 7 rows, 5 distinct names
  });
});

describe("classifyFbRung", () => {
  it("ok when rows came back", () => {
    expect(classifyFbRung(true, undefined, 5)).toEqual({ kind: "ok" });
  });

  it("🔴 HTTP 200 with zero rows is the missing-scope SENTINEL, never a descent", () => {
    // Descending here would double every under-scoped channel's calls for nothing,
    // and would destroy the sentinel's meaning.
    expect(classifyFbRung(true, undefined, 0)).toEqual({ kind: "empty" });
  });

  it("descends only on a genuine invalid-metric-NAME error", () => {
    expect(
      classifyFbRung(false, { code: 100, message: "(#100) The value must be a valid insights metric" }, 0)
    ).toEqual({ kind: "bad_metric" });
    expect(
      classifyFbRung(false, { code: 100, message: "does not support the profile_visits metric for this media product type" }, 0)
    ).toEqual({ kind: "bad_metric" });
  });

  it("🔴 #100 subcode 33 is object-not-found, NOT a bad metric name", () => {
    // A deleted post must not trigger an endless pointless descent.
    expect(
      classifyFbRung(false, { code: 100, error_subcode: 33, message: "Unsupported get request. Object with ID does not exist" }, 0)
    ).toEqual({ kind: "hard_error" });
  });

  it("#100 without a name-error message is a hard error", () => {
    expect(classifyFbRung(false, { code: 100, message: "Tried accessing nonexisting object" }, 0)).toEqual({
      kind: "hard_error",
    });
  });

  it("token / rate / permission errors never descend — a shorter list cannot fix them", () => {
    for (const err of [
      { code: 190, error_subcode: 460, message: "session invalidated" },
      { code: 10, message: "requires pages_read_user_content" },
      { code: 200, message: "read_insights permission missing" },
      { code: 4, message: "Application request limit reached" },
      { code: 1, message: "unknown" },
    ]) {
      expect(classifyFbRung(false, err, 0).kind).toBe("hard_error");
    }
  });
});

describe("isFbMediaViewEnabled — fail CLOSED", () => {
  it("only the literal 'true' enables it", () => {
    expect(isFbMediaViewEnabled({ FB_MEDIA_VIEW_METRICS_ENABLED: "true" } as any)).toBe(true);
  });

  it("🔴 an UNPLUMBED variable (empty string) must NOT enable it", () => {
    // docker-compose.prod.yml uses an explicit `environment:` allowlist, so a key
    // present only in .env.prod arrives as "". A fail-open `!== "false"` check
    // would read that as ENABLED — the PR #166 incident.
    expect(isFbMediaViewEnabled({ FB_MEDIA_VIEW_METRICS_ENABLED: "" } as any)).toBe(false);
    expect(isFbMediaViewEnabled({} as any)).toBe(false);
    expect(isFbMediaViewEnabled({ FB_MEDIA_VIEW_METRICS_ENABLED: "1" } as any)).toBe(false);
    expect(isFbMediaViewEnabled({ FB_MEDIA_VIEW_METRICS_ENABLED: "TRUE" } as any)).toBe(false);
  });
});

/**
 * 🔴 THE CONFIDENT-ZERO REACH BUG (measured on prod 2026-08-12).
 *
 * 113 Facebook ExternalPost rows synced that day carried impressions > 0,
 * reach = 0, metricsSource = "api" AND metricsAvailable.reach = "true" — a
 * fabricated zero declared available. One of them stored reach 0 while Graph
 * reported post_total_media_view_unique lifetime 16,438.
 *
 * Cause: availability came from presentMetricNames (which iterates EVERY row, so
 * a lone stale period=day row marks the metric present) while the VALUE came
 * from selectLifetimeRow. When only a day row exists, the two disagree.
 * post_media_view is lifetime-only, which is exactly why impressions survived on
 * the same row — the asymmetry that fingerprints the bug.
 */
describe("hasTrustedValue — availability must match the row the value came from", () => {
  const dayOnly: FbInsightRow[] = [
    { name: "post_total_media_view_unique", period: "day", values: [{ value: 0, end_time: "2026-08-11" }] },
  ];
  const lifetimeThenDay: FbInsightRow[] = [
    { name: "post_total_media_view_unique", period: "lifetime", values: [{ value: 16438 }] },
    { name: "post_total_media_view_unique", period: "day", values: [{ value: 0, end_time: "2026-08-11" }] },
  ];

  it("🔴 a day-ONLY response is NOT trusted — this is the fabricated zero", () => {
    // presentMetricNames says true (the name is there); the value is the day 0.
    expect(presentMetricNames(dayOnly).has("post_total_media_view_unique")).toBe(true);
    expect(readMetricValue(dayOnly, "post_total_media_view_unique")).toBe(0);
    // …so availability must NOT follow presentMetricNames.
    expect(hasTrustedValue(dayOnly, "post_total_media_view_unique")).toBe(false);
  });

  it("trusts a lifetime row even when a stale day row trails it", () => {
    expect(hasTrustedValue(lifetimeThenDay, "post_total_media_view_unique")).toBe(true);
    expect(readMetricValue(lifetimeThenDay, "post_total_media_view_unique")).toBe(16438);
  });

  it("is false for a metric that is absent entirely", () => {
    expect(hasTrustedValue(lifetimeThenDay, "post_clicks")).toBe(false);
  });

  it("still trusts a row with NO period — preserves the deliberate fallback", () => {
    const noPeriod: FbInsightRow[] = [{ name: "post_clicks", values: [{ value: 7 }] }];
    expect(hasTrustedValue(noPeriod, "post_clicks")).toBe(true);
    expect(readMetricValue(noPeriod, "post_clicks")).toBe(7);
  });

  it("agrees with presentMetricNames on the normal lifetime-only shape", () => {
    const normal: FbInsightRow[] = [
      { name: "post_media_view", period: "lifetime", values: [{ value: 5063 }] },
    ];
    expect(hasTrustedValue(normal, "post_media_view")).toBe(true);
    expect(presentMetricNames(normal).has("post_media_view")).toBe(true);
  });
});
