import { describe, it, expect, vi, beforeEach } from "vitest";
import { FacebookProvider } from "../providers/facebook.provider";
import * as scrapers from "@postautomation/social-scrapers";

vi.mock("@postautomation/social-scrapers", () => ({
  scrapeFacebookReelEngagement: vi.fn(),
  scrapeFacebookPageFollowers: vi.fn(),
}));

const tokens = { accessToken: "tok" } as any;

/**
 * Locks the honesty declaration on the Facebook reel-SCRAPE branch of
 * getVideoAnalytics.
 *
 * ⚠️ Why this matters. `metricsAvailable` is read downstream by
 * gatePostReportRow / effectiveChannelUnavailable with the rule "metadata is
 * present and the key is not false ⇒ trust the value". An OMITTED key therefore
 * reads as AVAILABLE. The scrape branch used to declare only three keys
 * ({reach, clicks, impressions}) while returning `likes`, `comments` and
 * `shares` — so every scraped capture published those three as confident
 * measurements.
 *
 * `shares` was the worst: `scrapeFacebookReelEngagement` returns
 * `shares: null` UNCONDITIONALLY (social-scrapers/src/facebook.ts — the return
 * is literally `{ ...parseFbReelHtml(html), shares: null }`), so the old
 * `scraped.shares ?? 0` fabricated a zero on 100% of scraped captures.
 *
 * Measured on prod 2026-08-08: 94% of Facebook ExternalPost rows are video, so
 * this branch is about to become the dominant capture path — the declaration
 * has to be right before the volume arrives.
 */
describe("Facebook reel-scrape branch declares every metric honestly", () => {
  beforeEach(() => vi.clearAllMocks());

  /** API reports no views (the only way to reach the scrape branch). */
  function apiWithoutViews(fields: Record<string, unknown> = {}) {
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      const body = u.includes("/video_insights") ? { data: [] } : fields;
      return { ok: true, json: async () => body } as any;
    }) as any;
  }

  const ALL_SIX = ["clicks", "comments", "impressions", "likes", "reach", "shares"];

  it("declares ALL SIX metricsAvailable keys — an omitted key reads as available", async () => {
    apiWithoutViews({ likes: { summary: { total_count: 1 } }, comments: { summary: { total_count: 0 } } });
    (scrapers.scrapeFacebookReelEngagement as any).mockResolvedValue({
      views: 5000, likes: 120, comments: 8, shares: null, caption: null,
    });

    const result = await new FacebookProvider().getPostAnalytics(tokens, "9999999999");

    expect(Object.keys(result!.metricsAvailable!).sort()).toEqual(ALL_SIX);
  });

  it("always declares shares:false — the scraper structurally cannot read shares", async () => {
    apiWithoutViews();
    (scrapers.scrapeFacebookReelEngagement as any).mockResolvedValue({
      views: 5000, likes: 120, comments: 8, shares: null, caption: null,
    });

    const result = await new FacebookProvider().getPostAnalytics(tokens, "9999999999");

    // The stored 0 is required by the column type; the DECLARATION is what makes
    // the UI render "—" instead of a confident "0 shares".
    expect(result?.shares).toBe(0);
    expect(result?.metricsAvailable?.shares).toBe(false);
  });

  it("declares likes:false and stores no fabricated count when reactions are unreadable", async () => {
    // og:title carried no reactions segment AND the video-fields call gave nothing.
    apiWithoutViews({});
    (scrapers.scrapeFacebookReelEngagement as any).mockResolvedValue({
      views: 3000, likes: null, comments: null, shares: null, caption: null,
    });

    const result = await new FacebookProvider().getPostAnalytics(tokens, "9999999999");

    expect(result?.impressions).toBe(3000); // the one thing we really measured
    expect(result?.metricsAvailable?.likes).toBe(false);
    expect(result?.metricsAvailable?.comments).toBe(false);
    expect(result?.metricsAvailable?.impressions).toBe(true);
  });

  it("declares likes/comments TRUE when the scraper did read them", async () => {
    apiWithoutViews();
    (scrapers.scrapeFacebookReelEngagement as any).mockResolvedValue({
      views: 54, likes: 7, comments: 2, shares: null, caption: null,
    });

    const result = await new FacebookProvider().getPostAnalytics(tokens, "9999999999");

    expect(result?.likes).toBe(7);
    expect(result?.comments).toBe(2);
    expect(result?.metricsAvailable?.likes).toBe(true);
    expect(result?.metricsAvailable?.comments).toBe(true);
  });

  it("falls back to the API value when the scraper could not read a metric", async () => {
    apiWithoutViews({ likes: { summary: { total_count: 9 } }, comments: { summary: { total_count: 4 } } });
    (scrapers.scrapeFacebookReelEngagement as any).mockResolvedValue({
      views: 54, likes: null, comments: null, shares: null, caption: null,
    });

    const result = await new FacebookProvider().getPostAnalytics(tokens, "9999999999");

    expect(result?.likes).toBe(9);
    expect(result?.comments).toBe(4);
    expect(result?.metricsAvailable?.likes).toBe(true);
    expect(result?.metricsAvailable?.comments).toBe(true);
  });

  it("labels the like kind 'reactions' — parseFbReelHtml counts og:title REACTIONS", async () => {
    apiWithoutViews();
    (scrapers.scrapeFacebookReelEngagement as any).mockResolvedValue({
      views: 5000, likes: 120, comments: 8, shares: null, caption: null,
    });

    const result = await new FacebookProvider().getPostAnalytics(tokens, "9999999999");

    // Matches the feed path, which also declares "reactions".
    expect(result?.likeKind).toBe("reactions");
  });

  it("leaves engagementRate at 0 — every read path recomputes it from impressioned rows", async () => {
    apiWithoutViews();
    (scrapers.scrapeFacebookReelEngagement as any).mockResolvedValue({
      views: 100, likes: 10, comments: 5, shares: null, caption: null,
    });

    const result = await new FacebookProvider().getPostAnalytics(tokens, "9999999999");

    // Storing a rate here would mix units with the SQL recompute (a fraction on
    // some platforms, a percent on others).
    expect(result?.engagementRate).toBe(0);
  });

  it("does not scrape when the API legitimately reported views", async () => {
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      const body = u.includes("/video_insights")
        ? { data: [{ name: "total_video_views", values: [{ value: 400 }] }] }
        : { likes: { summary: { total_count: 10 } }, comments: { summary: { total_count: 2 } } };
      return { ok: true, json: async () => body } as any;
    }) as any;

    const result = await new FacebookProvider().getPostAnalytics(tokens, "8888888888");

    expect(result?.source).toBe("api");
    expect(scrapers.scrapeFacebookReelEngagement).not.toHaveBeenCalled();
  });
});
