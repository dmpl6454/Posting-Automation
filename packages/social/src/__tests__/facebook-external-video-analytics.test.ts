import { describe, it, expect, vi, beforeEach } from "vitest";
import { FacebookProvider } from "../providers/facebook.provider";
import * as scrapers from "@postautomation/social-scrapers";

vi.mock("@postautomation/social-scrapers", () => ({
  scrapeFacebookReelEngagement: vi.fn(),
  scrapeFacebookPageFollowers: vi.fn(),
}));

const tokens = { accessToken: "tok" } as any;
const PAGE = "100325106185043";
const COMPOSITE = `${PAGE}_1041943175359813`;
const VIDEO = "884975274344793";

/**
 * Facebook video-view recovery for posts we did NOT publish.
 *
 * Context (prod 2026-08-08): 94% of FB `ExternalPost` rows are video and ALL of
 * them stored `impressions = 0`. `getPostAnalytics` routes to the Video-node
 * path by ID SHAPE (`!id.includes("_")`), and external posts are always
 * composite, so the video branch never fired. The feed edge does request
 * `post_video_views`, but it returns 0 for every video (measured 40/40) — the
 * real count lives on the Video/Reel node.
 *
 * ⚠️ STRICT fetch mock. The sibling FB suites use a catch-all default branch
 * that answers ANY unmatched URL with the fields body, so an inserted network
 * call would ship uncovered. Here an unmatched URL THROWS — which is what makes
 * the two byte-identity tests below meaningful.
 */
function strictFetch(routes: Array<[RegExp, any]>, seen: string[]) {
  global.fetch = vi.fn(async (url: any) => {
    const u = String(url);
    seen.push(u);
    for (const [re, body] of routes) {
      if (re.test(u)) return { ok: body?.__notOk !== true, json: async () => body } as any;
    }
    throw new Error(`UNEXPECTED FETCH: ${u}`);
  }) as any;
}

const FEED_INSIGHTS: [RegExp, any] = [
  /\/insights\?metric=post_clicks/,
  { data: [{ name: "post_clicks", values: [{ value: 42 }] }] },
];
const FEED_FIELDS: [RegExp, any] = [
  /\?fields=shares,comments\.summary/,
  { shares: { count: 7 }, comments: { summary: { total_count: 3 } }, reactions: { summary: { total_count: 11 } } },
];

describe("the publish-shared path is untouched", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a COMPOSITE id through getPostAnalytics makes EXACTLY the two feed calls", async () => {
    // ⚠️ This is the publish-path lock. post-publish.worker step 4b calls
    // getPostAnalytics, and app-published FB posts are frequently composite-id.
    // The assertion that matters is the ABSENCE of a third call: no attachments
    // resolve, no video_insights, no scrape.
    const seen: string[] = [];
    strictFetch([FEED_INSIGHTS, FEED_FIELDS], seen);

    const r = await new FacebookProvider().getPostAnalytics(tokens, COMPOSITE);

    expect(seen).toHaveLength(2);
    expect(seen.some((u) => u.includes("attachments"))).toBe(false);
    expect(seen.some((u) => u.includes("video_insights"))).toBe(false);
    expect(scrapers.scrapeFacebookReelEngagement).not.toHaveBeenCalled();
    // And the feed metrics still land exactly as before.
    expect(r?.clicks).toBe(42);
    expect(r?.shares).toBe(7);
    expect(r?.metricsAvailable?.impressions).toBe(false);
  });

  it("a BARE id still routes to the Video node, in order", async () => {
    const seen: string[] = [];
    strictFetch(
      [
        [/\/video_insights\?metric=total_video_impressions/, { data: [{ name: "total_video_views", values: [{ value: 185 }] }] }],
        [/\?fields=likes\.summary/, { likes: { summary: { total_count: 4 } }, comments: { summary: { total_count: 1 } } }],
      ],
      seen
    );

    const r = await new FacebookProvider().getPostAnalytics(tokens, "123456789012345");

    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("/video_insights");
    expect(r?.impressions).toBe(185);
  });
});

describe("getExternalPostAnalytics MERGES a view count onto the feed capture", () => {
  beforeEach(() => vi.clearAllMocks());

  it("PRESERVES feed clicks/shares/comments/likes and changes ONLY impressions", async () => {
    // Routing video posts to getVideoAnalytics instead would have declared
    // clicks:false and shares:false, trading an impressions gap for a
    // clicks/shares gap across 22,419 / 8,714 prod rows that already have them.
    const seen: string[] = [];
    strictFetch([FEED_INSIGHTS, FEED_FIELDS], seen);
    (scrapers.scrapeFacebookReelEngagement as any).mockResolvedValue({
      views: 54, likes: null, comments: null, shares: null, caption: null,
    });

    const r = await new FacebookProvider().getExternalPostAnalytics(tokens, COMPOSITE, {
      pageId: PAGE,
      videoId: VIDEO,
      isReel: true,
      allowScrape: true,
    });

    expect(r?.impressions).toBe(54);
    expect(r?.clicks).toBe(42);
    expect(r?.shares).toBe(7);
    expect(r?.comments).toBe(3);
    expect(r?.likes).toBe(11);
    expect(r?.metricsAvailable?.impressions).toBe(true);
    // The feed's own declarations survive the merge untouched.
    expect(r?.metricsAvailable?.shares).toBe(true);
    expect(r?.metricsAvailable?.clicks).toBe(true);
    expect(r?.source).toBe("scrape");
  });

  it("a REEL skips video_insights entirely", async () => {
    // Measured 0 view rows on 36/36 reels — asking spends app quota (a shared,
    // module-global budget the publish path reads) for nothing.
    const seen: string[] = [];
    strictFetch([FEED_INSIGHTS, FEED_FIELDS], seen);
    (scrapers.scrapeFacebookReelEngagement as any).mockResolvedValue({
      views: 452, likes: null, comments: null, shares: null, caption: null,
    });

    await new FacebookProvider().getExternalPostAnalytics(tokens, COMPOSITE, {
      pageId: PAGE, videoId: VIDEO, isReel: true, allowScrape: true,
    });

    expect(seen.some((u) => u.includes("video_insights"))).toBe(false);
  });

  it("a NON-reel video asks the Video node first and does not scrape when it answers", async () => {
    const seen: string[] = [];
    strictFetch(
      [
        FEED_INSIGHTS,
        FEED_FIELDS,
        [/\/video_insights/, { data: [{ name: "total_video_views", values: [{ value: 900 }] }] }],
      ],
      seen
    );

    const r = await new FacebookProvider().getExternalPostAnalytics(tokens, COMPOSITE, {
      pageId: PAGE, videoId: VIDEO, isReel: false, allowScrape: true,
    });

    expect(r?.impressions).toBe(900);
    expect(r?.source).toBe("api");
    expect(scrapers.scrapeFacebookReelEngagement).not.toHaveBeenCalled();
  });

  it("a scrape MISS leaves impressions declared FALSE (renders — not a fake 0)", async () => {
    const seen: string[] = [];
    strictFetch([FEED_INSIGHTS, FEED_FIELDS], seen);
    (scrapers.scrapeFacebookReelEngagement as any).mockResolvedValue({
      views: null, likes: null, comments: null, shares: null, walled: true,
    });

    const r = await new FacebookProvider().getExternalPostAnalytics(tokens, COMPOSITE, {
      pageId: PAGE, videoId: VIDEO, isReel: true, allowScrape: true,
    });

    expect(r?.impressions).toBe(0);
    expect(r?.metricsAvailable?.impressions).toBe(false);
    // Fail-open: the feed metrics still land.
    expect(r?.clicks).toBe(42);
  });

  it("does not scrape when allowScrape is false (budget exhausted / kill switch)", async () => {
    const seen: string[] = [];
    strictFetch([FEED_INSIGHTS, FEED_FIELDS], seen);

    const r = await new FacebookProvider().getExternalPostAnalytics(tokens, COMPOSITE, {
      pageId: PAGE, videoId: VIDEO, isReel: true, allowScrape: false,
    });

    expect(scrapers.scrapeFacebookReelEngagement).not.toHaveBeenCalled();
    expect(r?.metricsAvailable?.impressions).toBe(false);
  });

  it("a NON-video post returns the feed capture with no extra calls", async () => {
    const seen: string[] = [];
    strictFetch([FEED_INSIGHTS, FEED_FIELDS, [/\?fields=attachments/, { id: COMPOSITE }]], seen);

    const r = await new FacebookProvider().getExternalPostAnalytics(tokens, COMPOSITE, {
      pageId: PAGE, videoId: null, allowScrape: true,
    });

    expect(r?.clicks).toBe(42);
    expect(r?.metricsAvailable?.impressions).toBe(false);
    expect(scrapers.scrapeFacebookReelEngagement).not.toHaveBeenCalled();
  });

  it("resolves the video id from attachments{target}, NEVER object_id", async () => {
    // object_id is deprecated — it returns #12 on v18.
    const seen: string[] = [];
    strictFetch(
      [
        FEED_INSIGHTS,
        FEED_FIELDS,
        [
          /\?fields=attachments/,
          { attachments: { data: [{ media_type: "video", target: { id: VIDEO, url: `https://www.facebook.com/reel/${VIDEO}/` } }] } },
        ],
      ],
      seen
    );
    (scrapers.scrapeFacebookReelEngagement as any).mockResolvedValue({
      views: 17, likes: null, comments: null, shares: null, caption: null,
    });

    const r = await new FacebookProvider().getExternalPostAnalytics(tokens, COMPOSITE, {
      pageId: PAGE, videoId: null, allowScrape: true,
    });

    expect(seen.some((u) => u.includes("object_id"))).toBe(false);
    expect(seen.some((u) => u.includes("attachments"))).toBe(true);
    // The resolved target URL marks it a reel, so video_insights is skipped.
    expect(seen.some((u) => u.includes("video_insights"))).toBe(false);
    expect(r?.impressions).toBe(17);
  });

  it("carries the feed's degradation through the merge (health-flap guard)", async () => {
    // A dead token degrades the feed capture. The verdict must SURVIVE the
    // merge: a "clean" video capture that dropped `degraded` would clear a
    // legitimate needs_reconnect verdict after its TTL — the 2026-08-06 health
    // flap, where the busiest FB channels read "ok" while actually broken.
    const seen: string[] = [];
    strictFetch(
      [
        [/\/insights\?metric=post_clicks/, { __notOk: true, error: { code: 190, error_subcode: 460, message: "session invalidated" } }],
        [/\?fields=shares,comments\.summary/, { __notOk: true, error: { code: 190, message: "session invalidated" } }],
        [/\?fields=shares&/, { __notOk: true, error: { code: 190, message: "session invalidated" } }],
      ],
      seen
    );
    (scrapers.scrapeFacebookReelEngagement as any).mockResolvedValue({
      views: 54, likes: null, comments: null, shares: null, caption: null,
    });

    const r = await new FacebookProvider().getExternalPostAnalytics(tokens, COMPOSITE, {
      pageId: PAGE, videoId: VIDEO, isReel: true, allowScrape: true,
    });

    expect(r?.degraded?.reason).toBe("token_invalid");
    // The scrape genuinely read a view count off the public page, so declaring
    // impressions available is HONEST even though the Graph calls failed —
    // the scraper does not use the token. Everything the feed could not read
    // stays declared false.
    expect(r?.impressions).toBe(54);
    expect(r?.metricsAvailable?.impressions).toBe(true);
    expect(r?.metricsAvailable?.clicks).toBe(false);
    expect(r?.metricsAvailable?.comments).toBe(false);
  });
});
