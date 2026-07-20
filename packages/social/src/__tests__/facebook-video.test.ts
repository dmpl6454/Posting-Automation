import { describe, it, expect, vi, afterEach } from "vitest";
import { FacebookProvider, FB_URL_PULL_MIN_BYTES } from "../providers/facebook.provider";

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

const tokens = { accessToken: "tk" };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("FacebookProvider.getPostAnalytics — VIDEO ids (bare node id, no underscore)", () => {
  it("routes bare video ids to video_insights + Video-node fields and maps views onto impressions", async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/video_insights")) {
        return jsonResponse({
          data: [
            { name: "total_video_impressions", values: [{ value: 500 }] },
            { name: "total_video_views", values: [{ value: 450 }] },
          ],
        });
      }
      if (u.includes("fields=likes.summary(true),comments.summary(true)")) {
        return jsonResponse({
          likes: { summary: { total_count: 10 } },
          comments: { summary: { total_count: 3 } },
        });
      }
      throw new Error(`Unexpected request: ${u}`);
    }) as any;

    const provider = new FacebookProvider();
    const result = await provider.getPostAnalytics(tokens, "123456789012345");

    // Video-node-valid endpoints only
    expect(urls[0]).toContain("/123456789012345/video_insights?metric=total_video_impressions,total_video_views");
    expect(urls[1]).toContain("/123456789012345?fields=likes.summary(true),comments.summary(true)");
    // No Post-node endpoints — `shares`/`reactions` are not Video-node fields
    // and would fail the whole Graph call (the original null-forever defect).
    expect(urls.some((u) => u.includes("post_impressions"))).toBe(false);
    expect(urls.some((u) => u.includes("fields=shares"))).toBe(false);

    expect(result).toEqual({
      impressions: 500,
      clicks: 0,
      likes: 10,
      shares: 0,
      comments: 3,
      reach: 0,
      engagementRate: (10 + 3) / 500,
    });
  });

  it("falls back to total_video_views for impressions when total_video_impressions is absent", async () => {
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("/video_insights")) {
        return jsonResponse({ data: [{ name: "total_video_views", values: [{ value: 450 }] }] });
      }
      return jsonResponse({
        likes: { summary: { total_count: 1 } },
        comments: { summary: { total_count: 0 } },
      });
    }) as any;

    const provider = new FacebookProvider();
    const result = await provider.getPostAnalytics(tokens, "9876543210");
    expect(result?.impressions).toBe(450);
  });

  it("warns-only on a video_insights failure but returns null when the Video fields fetch fails (windowTag one-shot semantics)", async () => {
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("/video_insights")) {
        return jsonResponse({ error: { message: "nope", code: 100 } }, 500);
      }
      return jsonResponse({ error: { message: "nope", code: 100 } }, 500);
    }) as any;

    const provider = new FacebookProvider();
    await expect(provider.getPostAnalytics(tokens, "9876543210")).resolves.toBeNull();
  });

  it("keeps the existing Post-node endpoints byte-identical for underscore ids (photos/text)", async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/insights?")) {
        return jsonResponse({
          data: [
            { name: "post_impressions", values: [{ value: 200 }] },
            { name: "post_clicks", values: [{ value: 20 }] },
            { name: "post_engaged_users", values: [{ value: 150 }] },
          ],
        });
      }
      return jsonResponse({
        shares: { count: 2 },
        comments: { summary: { total_count: 4 } },
        reactions: { summary: { total_count: 8 } },
      });
    }) as any;

    const provider = new FacebookProvider();
    const result = await provider.getPostAnalytics(tokens, "111_222");

    expect(urls[0]).toContain(
      "/111_222/insights?metric=post_impressions,post_clicks,post_reactions_like_total,post_engaged_users"
    );
    expect(urls[1]).toContain("/111_222?fields=shares,comments.summary(true),reactions.summary(true)");
    expect(result).toEqual({
      impressions: 200,
      clicks: 20,
      likes: 8,
      shares: 2,
      comments: 4,
      reach: 150,
      engagementRate: (8 + 2 + 4) / 200,
    });
  });
});

describe("FacebookProvider video publish — publishedUrl + file_url remote-pull", () => {
  const videoPayload = {
    content: "my caption",
    mediaUrls: ["https://s3.example.com/vid.mp4"],
    mediaTypes: ["video/mp4"],
    metadata: { pageId: "PAGE1" },
  };

  it("small video keeps the buffered multipart path and builds /{page}/videos/{id} URL (not the dead facebook.com/{videoId})", async () => {
    const graphCalls: Array<{ url: string; init: any }> = [];
    global.fetch = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u.startsWith("https://s3.example.com/") && init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-length": "1024", "content-type": "video/mp4" },
        });
      }
      if (u.startsWith("https://s3.example.com/")) {
        return new Response(new Uint8Array(1024), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      }
      graphCalls.push({ url: u, init });
      return jsonResponse({ id: "999" });
    }) as any;

    const provider = new FacebookProvider();
    const result = await provider.publishPost(tokens, videoPayload);

    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0]!.url).toContain("/PAGE1/videos");
    // Buffered path = multipart body, NOT file_url
    expect(String(graphCalls[0]!.init?.headers?.["Content-Type"])).toContain("multipart/form-data");
    expect(result.platformPostId).toBe("999");
    expect(result.url).toBe("https://www.facebook.com/PAGE1/videos/999");
  });

  it("uses the post permalink form when Graph DOES return post_id", async () => {
    global.fetch = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u.startsWith("https://s3.example.com/") && init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-length": "1024", "content-type": "video/mp4" },
        });
      }
      if (u.startsWith("https://s3.example.com/")) {
        return new Response(new Uint8Array(1024), { status: 200 });
      }
      return jsonResponse({ id: "999", post_id: "PAGE1_777" });
    }) as any;

    const provider = new FacebookProvider();
    const result = await provider.publishPost(tokens, videoPayload);
    expect(result.platformPostId).toBe("PAGE1_777");
    expect(result.url).toBe("https://www.facebook.com/PAGE1/posts/777");
  });

  it("large video (> FB_URL_PULL_MIN_BYTES) publishes via file_url remote-pull — no download, no multipart", async () => {
    const graphCalls: Array<{ url: string; init: any }> = [];
    let mediaDownloaded = false;
    global.fetch = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u.startsWith("https://s3.example.com/") && init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": String(FB_URL_PULL_MIN_BYTES + 1),
            "content-type": "video/mp4",
          },
        });
      }
      if (u.startsWith("https://s3.example.com/")) {
        mediaDownloaded = true;
        return new Response(new Uint8Array(8), { status: 200 });
      }
      graphCalls.push({ url: u, init });
      return jsonResponse({ id: "888" });
    }) as any;

    const provider = new FacebookProvider();
    const result = await provider.publishPost(tokens, videoPayload);

    expect(mediaDownloaded).toBe(false); // the worker never buffers the file
    expect(graphCalls).toHaveLength(1);
    expect(graphCalls[0]!.url).toContain("/PAGE1/videos");
    const body = String(graphCalls[0]!.init?.body);
    expect(body).toContain("file_url=" + encodeURIComponent("https://s3.example.com/vid.mp4"));
    expect(body).toContain("description=my+caption");
    expect(String(graphCalls[0]!.init?.headers?.["Content-Type"])).toBe(
      "application/x-www-form-urlencoded"
    );
    expect(result.url).toBe("https://www.facebook.com/PAGE1/videos/888");
  });

  it("falls back to the buffered path when the size probe fails (unknown size)", async () => {
    const graphCalls: Array<{ url: string; init: any }> = [];
    global.fetch = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u.startsWith("https://s3.example.com/") && init?.method === "HEAD") {
        return new Response(null, { status: 405 });
      }
      if (u.startsWith("https://s3.example.com/") && init?.headers?.Range === "bytes=0-0") {
        // headRemoteMedia's ranged fallback also fails → size unknown
        return new Response(null, { status: 200 });
      }
      if (u.startsWith("https://s3.example.com/")) {
        return new Response(new Uint8Array(64), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      }
      graphCalls.push({ url: u, init });
      return jsonResponse({ id: "777" });
    }) as any;

    const provider = new FacebookProvider();
    const result = await provider.publishPost(tokens, videoPayload);
    expect(String(graphCalls[0]!.init?.headers?.["Content-Type"])).toContain("multipart/form-data");
    expect(result.url).toBe("https://www.facebook.com/PAGE1/videos/777");
  });
});
