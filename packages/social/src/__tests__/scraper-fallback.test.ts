import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the vendored scraper package BEFORE importing the providers.
vi.mock("@postautomation/social-scrapers", () => ({
  scrapeFacebookReelEngagement: vi.fn(),
  scrapeSnapchatSpotlightEngagement: vi.fn(),
}));

import * as scrapers from "@postautomation/social-scrapers";
import { FacebookProvider } from "../providers/facebook.provider";
import { SnapchatProvider } from "../providers/snapchat.provider";

const tokens = { accessToken: "tk" } as any;

beforeEach(() => vi.clearAllMocks());

describe("Facebook video analytics — scraper fallback", () => {
  it("falls back to the reel scraper when API insights are all-zero", async () => {
    // API: video_insights returns nothing (permission-fail signature), fields OK
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      const body = u.includes("/video_insights")
        ? { data: [] }
        : { likes: { summary: { total_count: 1 } }, comments: { summary: { total_count: 0 } } };
      return { ok: true, json: async () => body } as any;
    }) as any;

    (scrapers.scrapeFacebookReelEngagement as any).mockResolvedValue({
      views: 5000, likes: 120, comments: 8, shares: null, caption: null,
    });

    const provider = new FacebookProvider();
    const result = await provider.getPostAnalytics(tokens, "9999999999"); // bare id → video path
    expect(result?.impressions).toBe(5000); // scraped views
    expect(result?.likes).toBe(120);
    expect(result?.comments).toBe(8);
    expect(result?.source).toBe("scrape");
  });

  it("keeps the API result (source=api) when the API returns real impressions", async () => {
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      const body = u.includes("/video_insights")
        ? { data: [{ name: "total_video_impressions", values: [{ value: 400 }] }] }
        : { likes: { summary: { total_count: 10 } }, comments: { summary: { total_count: 2 } } };
      return { ok: true, json: async () => body } as any;
    }) as any;

    const provider = new FacebookProvider();
    const result = await provider.getPostAnalytics(tokens, "8888888888");
    expect(result?.impressions).toBe(400);
    expect(result?.source).toBe("api");
    expect(scrapers.scrapeFacebookReelEngagement).not.toHaveBeenCalled();
  });

  it("fails open (keeps API zeros) when the scraper misses", async () => {
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      const body = u.includes("/video_insights")
        ? { data: [] }
        : { likes: { summary: { total_count: 3 } }, comments: { summary: { total_count: 1 } } };
      return { ok: true, json: async () => body } as any;
    }) as any;
    (scrapers.scrapeFacebookReelEngagement as any).mockResolvedValue({
      views: null, likes: null, comments: null, shares: null, caption: null,
    });

    const provider = new FacebookProvider();
    const result = await provider.getPostAnalytics(tokens, "7777777777");
    expect(result?.impressions).toBe(0); // API zeros kept
    expect(result?.source).toBe("api");
  });
});

describe("Snapchat analytics — spotlight scraper", () => {
  it("returns scraped spotlight engagement (likes always unavailable)", async () => {
    (scrapers.scrapeSnapchatSpotlightEngagement as any).mockResolvedValue({
      views: 3000, likes: null, comments: 12, shares: 5, caption: null,
    });
    const provider = new SnapchatProvider();
    const result = await provider.getPostAnalytics(tokens, "spotlight-id");
    expect(result?.impressions).toBe(3000);
    expect(result?.comments).toBe(12);
    expect(result?.shares).toBe(5);
    expect(result?.likes).toBe(0);
    expect(result?.metricsAvailable?.likes).toBe(false);
    expect(result?.source).toBe("scrape");
  });

  it("returns null (fail-open) when the scraper misses", async () => {
    (scrapers.scrapeSnapchatSpotlightEngagement as any).mockResolvedValue({
      views: null, likes: null, comments: null, shares: null, caption: null,
    });
    const provider = new SnapchatProvider();
    expect(await provider.getPostAnalytics(tokens, "x")).toBeNull();
  });
});
