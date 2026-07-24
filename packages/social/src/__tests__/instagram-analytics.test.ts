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
  it("REELS: requests the v18 verified metric set (views not plays) and captures views/saved/shares/total_interactions", async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("fields=like_count,comments_count,media_product_type")) {
        return jsonResponse({ like_count: 7, comments_count: 2, media_product_type: "REELS" });
      }
      if (u.includes("/insights?")) {
        // Mirrors a real v18 Reel response: views (not plays), reach, saved,
        // shares, total_interactions.
        return jsonResponse({
          data: [
            { name: "reach", values: [{ value: 800 }] },
            { name: "saved", values: [{ value: 4 }] },
            { name: "shares", values: [{ value: 5 }] },
            { name: "views", values: [{ value: 1000 }] },
            { name: "likes", values: [{ value: 7 }] },
            { name: "comments", values: [{ value: 2 }] },
            { name: "total_interactions", values: [{ value: 14 }] },
          ],
        });
      }
      throw new Error(`Unexpected request: ${u}`);
    }) as any;

    const provider = new InstagramProvider();
    const result = await provider.getPostAnalytics(tokens, "IG_MEDIA_1");

    const insightsUrl = urls.find((u) => u.includes("/insights?"))!;
    // v18-valid set (live-verified 2026-07-24). `plays`/`impressions`/`engagement`
    // are INVALID in v18 and would #100 the whole call, so they must never appear.
    expect(insightsUrl).toContain("metric=reach,saved,shares,views,likes,comments,total_interactions");
    expect(insightsUrl).not.toContain("plays");
    expect(insightsUrl).not.toContain("impressions");
    expect(insightsUrl).not.toContain("engagement");

    expect(result).toMatchObject({
      impressions: 1000, // views ride on impressions
      clicks: 0,
      likes: 7, // from like_count field (authoritative), not the insights `likes`
      shares: 5, // now captured (was silently dropped by the old `plays` #100)
      comments: 2,
      reach: 800,
      engagementRate: 14 / 1000, // total_interactions / views
      saved: 4, // now surfaced (was dropped)
      likeKind: "likes",
      source: "api",
    });
  });

  it("STORY: requests the v18 story metric set (no saved/likes/comments; adds replies)", async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("media_product_type")) {
        return jsonResponse({ like_count: 0, comments_count: 0, media_product_type: "STORY" });
      }
      return jsonResponse({
        data: [
          { name: "reach", values: [{ value: 40 }] },
          { name: "shares", values: [{ value: 2 }] },
          { name: "views", values: [{ value: 50 }] },
          { name: "total_interactions", values: [{ value: 6 }] },
          { name: "replies", values: [{ value: 1 }] },
        ],
      });
    }) as any;

    const provider = new InstagramProvider();
    const result = await provider.getPostAnalytics(tokens, "IG_STORY_1");
    // v18-verified STORY set: saved/likes/comments are INVALID for stories (#100).
    expect(urls.find((u) => u.includes("/insights?"))).toContain("metric=reach,shares,views,total_interactions,replies");
    expect(result?.impressions).toBe(50); // views ride on impressions
    expect(result?.reach).toBe(40);
    expect(result?.shares).toBe(2);
  });

  it("FEED: requests the same v18 core set as REELS (views not impressions; no engagement)", async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("media_product_type")) {
        return jsonResponse({ like_count: 3, comments_count: 1, media_product_type: "FEED" });
      }
      return jsonResponse({
        data: [
          { name: "reach", values: [{ value: 90 }] },
          { name: "saved", values: [{ value: 2 }] },
          { name: "shares", values: [{ value: 0 }] },
          { name: "views", values: [{ value: 100 }] },
          { name: "likes", values: [{ value: 3 }] },
          { name: "comments", values: [{ value: 1 }] },
          { name: "total_interactions", values: [{ value: 10 }] },
        ],
      });
    }) as any;

    const provider = new InstagramProvider();
    const result = await provider.getPostAnalytics(tokens, "IG_FEED_1");
    const insightsUrl = urls.find((u) => u.includes("/insights?"))!;
    // FEED shares the REELS core set in v18. `impressions`/`engagement` invalid → never requested.
    expect(insightsUrl).toContain("/IG_FEED_1/insights?metric=reach,saved,shares,views,likes,comments,total_interactions&access_token=tk");
    expect(insightsUrl).not.toContain("impressions");
    expect(insightsUrl).not.toContain("engagement");
    expect(result).toMatchObject({
      impressions: 100,
      clicks: 0,
      likes: 3,
      shares: 0,
      comments: 1,
      reach: 90,
      saved: 2,
      engagementRate: 10 / 100, // total_interactions / views
      likeKind: "likes",
      source: "api",
    });
  });

  it("unknown/absent media_product_type uses the FEED/REELS core set", async () => {
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
    expect(urls.find((u) => u.includes("/insights?"))).toContain("metric=reach,saved,shares,views,likes,comments,total_interactions");
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
