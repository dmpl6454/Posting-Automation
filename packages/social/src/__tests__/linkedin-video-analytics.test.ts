import { describe, it, expect, vi, afterEach } from "vitest";
import { LinkedInProvider } from "../providers/linkedin.provider";

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const videoPayload = {
  content: "video post",
  mediaUrls: ["https://s3.example.com/vid.mp4"],
  mediaTypes: ["video/mp4"],
  metadata: { orgId: "555" },
};

/** Mock the full video upload chain; `finalizeStatus` controls the commit step. */
function mockVideoChain(finalizeStatus: number, calls: string[]) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith("https://s3.example.com/") && init?.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-length": "1000", "content-type": "video/mp4" },
      });
    }
    if (u.startsWith("https://s3.example.com/")) {
      // ranged chunk fetch
      return new Response(new Uint8Array(1000), { status: 206 });
    }
    if (u.includes("/rest/videos?action=initializeUpload")) {
      return jsonResponse({
        value: {
          video: "urn:li:video:V1",
          uploadInstructions: [
            { uploadUrl: "https://li-upload.example.com/1", firstByte: 0, lastByte: 999 },
          ],
        },
      });
    }
    if (u.startsWith("https://li-upload.example.com/")) {
      return new Response(null, { status: 200 });
    }
    if (u.includes("/rest/videos?action=finalizeUpload")) {
      return finalizeStatus === 200
        ? jsonResponse({}, 200)
        : new Response("upstream error", { status: finalizeStatus });
    }
    if (u.includes("/rest/posts")) {
      return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:99" } });
    }
    throw new Error(`Unexpected request: ${u}`);
  }) as any;
}

describe("LinkedInProvider video finalize failure", () => {
  it("THROWS on a non-OK finalize (no more console.warn swallow) and never creates the post", async () => {
    const calls: string[] = [];
    mockVideoChain(500, calls);

    const provider = new LinkedInProvider();
    await expect(
      provider.publishPost({ accessToken: "tk" }, videoPayload)
    ).rejects.toThrow(/LinkedIn video finalize failed \(500\)/);

    // The post must NOT be created against an unfinalized video URN
    expect(calls.some((u) => u.includes("/rest/posts"))).toBe(false);
  });

  it("happy path unchanged: finalize OK → post created with the video URN", async () => {
    const calls: string[] = [];
    mockVideoChain(200, calls);

    const provider = new LinkedInProvider();
    const result = await provider.publishPost({ accessToken: "tk" }, videoPayload);
    expect(calls.some((u) => u.includes("/rest/posts"))).toBe(true);
    expect(result.platformPostId).toBe("urn:li:share:99");
  });
});

describe("LinkedInProvider.getPostAnalytics — org share statistics", () => {
  const postId = "urn:li:share:12345";

  it("merges organizationalEntityShareStatistics into impressions/clicks/shares/reach for Page channels", async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/rest/socialActions/")) {
        return jsonResponse({
          likesSummary: { totalLikes: 4 },
          commentsSummary: { totalFirstLevelComments: 1 },
        });
      }
      if (u.includes("/rest/organizationalEntityShareStatistics")) {
        return jsonResponse({
          elements: [
            {
              totalShareStatistics: {
                impressionCount: 100,
                clickCount: 9,
                shareCount: 2,
                uniqueImpressionsCount: 60,
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${u}`);
    }) as any;

    const provider = new LinkedInProvider();
    const result = await provider.getPostAnalytics(
      { accessToken: "tk", metadata: { orgId: "555" } },
      postId
    );

    const statsUrl = urls.find((u) => u.includes("organizationalEntityShareStatistics"))!;
    expect(statsUrl).toContain("q=organizationalEntity");
    expect(statsUrl).toContain(encodeURIComponent("urn:li:organization:555"));
    expect(statsUrl).toContain(`shares=List(${encodeURIComponent(postId)})`);

    expect(result).toEqual({
      impressions: 100,
      clicks: 9,
      likes: 4,
      shares: 2,
      comments: 1,
      reach: 60,
      engagementRate: (4 + 1 + 2) / 100, // 0–1 fraction, consistent with YT/IG/FB
    });
  });

  it("VIDEO posts (urn:li:ugcPost:*) use the ugcPosts finder param — the shares param only accepts share URNs", async () => {
    const videoPostId = "urn:li:ugcPost:12345";
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("/rest/socialActions/")) {
        return jsonResponse({
          likesSummary: { totalLikes: 7 },
          commentsSummary: { totalFirstLevelComments: 2 },
        });
      }
      if (u.includes("/rest/organizationalEntityShareStatistics")) {
        return jsonResponse({
          elements: [
            {
              totalShareStatistics: {
                impressionCount: 500,
                clickCount: 11,
                shareCount: 3,
                uniqueImpressionsCount: 320,
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${u}`);
    }) as any;

    const provider = new LinkedInProvider();
    const result = await provider.getPostAnalytics(
      { accessToken: "tk", metadata: { orgId: "555" } },
      videoPostId
    );

    const statsUrl = urls.find((u) => u.includes("organizationalEntityShareStatistics"))!;
    expect(statsUrl).toContain(`ugcPosts=List(${encodeURIComponent(videoPostId)})`);
    expect(statsUrl).not.toContain("shares=List");

    expect(result?.impressions).toBe(500);
    expect(result?.clicks).toBe(11);
    expect(result?.shares).toBe(3);
    expect(result?.reach).toBe(320);
  });

  it("member posts (no orgId in tokens.metadata) keep the likes/comments-only shape and make NO stats call", async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: any) => {
      urls.push(String(url));
      return jsonResponse({
        likesSummary: { totalLikes: 3 },
        commentsSummary: { totalFirstLevelComments: 2 },
      });
    }) as any;

    const provider = new LinkedInProvider();
    const result = await provider.getPostAnalytics({ accessToken: "tk" }, postId);
    expect(urls).toHaveLength(1);
    expect(result).toEqual({
      impressions: 0,
      clicks: 0,
      likes: 3,
      shares: 0,
      comments: 2,
      reach: 0,
      engagementRate: 0,
    });
  });

  it("NEVER throws when the stats call fails — keeps zeros so at-age checkpoints still capture likes/comments", async () => {
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("/rest/socialActions/")) {
        return jsonResponse({
          likesSummary: { totalLikes: 5 },
          commentsSummary: { totalFirstLevelComments: 0 },
        });
      }
      throw new Error("network down");
    }) as any;

    const provider = new LinkedInProvider();
    const result = await provider.getPostAnalytics(
      { accessToken: "tk", metadata: { orgId: "555" } },
      postId
    );
    expect(result).toEqual({
      impressions: 0,
      clicks: 0,
      likes: 5,
      shares: 0,
      comments: 0,
      reach: 0,
      engagementRate: 0,
    });
  });
});
