import { describe, it, expect, vi, afterEach } from "vitest";
import { InstagramProvider } from "../providers/instagram.provider";

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

const tokens = { accessToken: "tk" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("InstagramProvider.getPostAnalytics — media_product_type metric selection", () => {
  it("REELS: requests the Reels metric set and maps plays onto impressions (views ride on impressions)", async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("fields=like_count,comments_count,media_product_type")) {
        return jsonResponse({ like_count: 7, comments_count: 2, media_product_type: "REELS" });
      }
      if (u.includes("/insights?")) {
        return jsonResponse({
          data: [
            { name: "plays", values: [{ value: 1000 }] },
            { name: "reach", values: [{ value: 800 }] },
            { name: "saved", values: [{ value: 4 }] },
            { name: "shares", values: [{ value: 5 }] },
            { name: "total_interactions", values: [{ value: 14 }] },
          ],
        });
      }
      throw new Error(`Unexpected request: ${u}`);
    }) as any;

    const provider = new InstagramProvider();
    const result = await provider.getPostAnalytics(tokens, "IG_MEDIA_1");

    const insightsUrl = urls.find((u) => u.includes("/insights?"))!;
    expect(insightsUrl).toContain("metric=plays,reach,saved,shares,total_interactions");
    // FEED-only metrics must NOT be requested on a Reel (all-or-nothing error #100)
    expect(insightsUrl).not.toContain("impressions");
    expect(insightsUrl).not.toContain("engagement");

    expect(result).toEqual({
      impressions: 1000, // plays ride on impressions
      clicks: 0,
      likes: 7,
      shares: 5,
      comments: 2,
      reach: 800,
      engagementRate: 14 / 1000, // total_interactions / plays
    });
  });

  it("STORY: requests the story metric set", async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("media_product_type")) {
        return jsonResponse({ like_count: 0, comments_count: 0, media_product_type: "STORY" });
      }
      return jsonResponse({
        data: [
          { name: "impressions", values: [{ value: 50 }] },
          { name: "reach", values: [{ value: 40 }] },
        ],
      });
    }) as any;

    const provider = new InstagramProvider();
    const result = await provider.getPostAnalytics(tokens, "IG_STORY_1");
    expect(urls.find((u) => u.includes("/insights?"))).toContain("metric=impressions,reach,replies");
    expect(result?.impressions).toBe(50);
    expect(result?.reach).toBe(40);
  });

  it("FEED: the insights request string stays byte-identical to the historical one (image path regress-proof)", async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("media_product_type")) {
        return jsonResponse({ like_count: 3, comments_count: 1, media_product_type: "FEED" });
      }
      return jsonResponse({
        data: [
          { name: "impressions", values: [{ value: 100 }] },
          { name: "reach", values: [{ value: 90 }] },
          { name: "engagement", values: [{ value: 10 }] },
        ],
      });
    }) as any;

    const provider = new InstagramProvider();
    const result = await provider.getPostAnalytics(tokens, "IG_FEED_1");
    const insightsUrl = urls.find((u) => u.includes("/insights?"))!;
    expect(insightsUrl).toContain("/IG_FEED_1/insights?metric=impressions,reach,engagement&access_token=tk");
    expect(result).toEqual({
      impressions: 100,
      clicks: 0,
      likes: 3,
      shares: 0,
      comments: 1,
      reach: 90,
      engagementRate: 10 / 100,
    });
  });

  it("unknown/absent media_product_type keeps the historical FEED metric set", async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("media_product_type")) {
        return jsonResponse({ like_count: 1, comments_count: 0 });
      }
      return jsonResponse({ data: [] });
    }) as any;

    const provider = new InstagramProvider();
    await provider.getPostAnalytics(tokens, "IG_X");
    expect(urls.find((u) => u.includes("/insights?"))).toContain("metric=impressions,reach,engagement");
  });

  it("retries ONCE with metric=reach when the product-type set fails — reach can never be zeroed by a metric mismatch again", async () => {
    const insightsCalls: string[] = [];
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("media_product_type")) {
        return jsonResponse({ like_count: 7, comments_count: 2, media_product_type: "REELS" });
      }
      if (u.includes("/insights?")) {
        insightsCalls.push(u);
        if (u.includes("metric=reach&")) {
          return jsonResponse({ data: [{ name: "reach", values: [{ value: 800 }] }] });
        }
        return jsonResponse({ error: { message: "Invalid metric", code: 100 } }, 400);
      }
      throw new Error(`Unexpected request: ${u}`);
    }) as any;

    const provider = new InstagramProvider();
    const result = await provider.getPostAnalytics(tokens, "IG_MEDIA_2");

    expect(insightsCalls).toHaveLength(2);
    expect(insightsCalls[1]).toContain("metric=reach&");
    expect(result?.reach).toBe(800);
    expect(result?.impressions).toBe(0);
    expect(result?.likes).toBe(7);
    // engagement falls back to likes+comments
    expect(result?.comments).toBe(2);
  });

  it("returns null when the media-fields fetch fails (contract unchanged)", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({ error: { message: "nope", code: 100 } }, 400)
    ) as any;
    const provider = new InstagramProvider();
    await expect(provider.getPostAnalytics(tokens, "IG_DEAD")).resolves.toBeNull();
  });
});
