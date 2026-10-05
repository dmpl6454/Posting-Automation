import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// The worker module imports the queue package, which opens Redis connections at
// import time; stub the handful of exports it reads so the suite needs no Redis.
vi.mock("@postautomation/queue", () => ({
  QUEUE_NAMES: { LISTENING_SYNC: "listening-sync" },
  sentimentAnalysisQueue: {},
  SENTIMENT_BATCH_SIZE: 20,
  LISTENING_SYNC_INTERVAL_MS: 30 * 60 * 1000,
  createRedisConnection: () => ({}),
}));

import { __listeningFetchers, __resetGdeltGate, __resetListeningTokenCache, __setYouTubeUnitCounter } from "../listening-sync.worker";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown, url = "https://graph.facebook.com/x"): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }) as Response & { url: string };
}

const channels = (rows: Array<{ id: string; platform: string; platformId: string; name: string }>) =>
  async () => rows.map((r) => ({ ...r, accessToken: `tok-${r.id}` }));

const ctx = (kws: string[], rows: Parameters<typeof channels>[0]) => ({
  keywords: kws,
  language: "en",
  organizationId: "org1",
  queryId: "q1",
  interactive: false,
  channels: channels(rows),
});

let fetchMock: FetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchFacebookTagged", () => {
  const tagged = {
    data: [
      {
        id: "111_222",
        message: "Loved the new Acme store opening!",
        created_time: "2026-10-03T10:00:00+0000",
        tagged_time: "2026-10-03T10:05:00+0000",
        permalink_url: "https://www.facebook.com/111/posts/222",
        shares: { count: 2 },
        reactions: { summary: { total_count: 10 } },
        comments: { summary: { total_count: 3 } },
      },
      { id: "111_333", message: "Unrelated weekend photo dump", created_time: "2026-10-02T10:00:00+0000", permalink_url: "https://www.facebook.com/111/posts/333" },
      { id: "111_444", story: "Priya was at Acme HQ.", created_time: "2026-10-01T10:00:00+0000", permalink_url: "https://www.facebook.com/111/posts/444" },
    ],
  };

  it("reads /tagged ONCE per distinct Page with the Page token and keeps keyword matches (message, story, or the Page's own name)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, tagged));
    const rows = [
      { id: "c1", platform: "FACEBOOK", platformId: "p1", name: "Acme Official" },
      { id: "c2", platform: "FACEBOOK", platformId: "p1", name: "Acme Official" }, // same Page, other workspace row
      { id: "c3", platform: "INSTAGRAM", platformId: "ig1", name: "acme" },
    ];
    const out = await __listeningFetchers.facebook(ctx(["acme"], rows));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v18\.0\/p1\/tagged\?fields=/);
    expect(url).toContain("access_token=tok-c1");
    expect(decodeURIComponent(url)).toContain("tagged_time");

    // Keyword "acme" matches the Page NAME, so every tagged post counts — brand monitoring.
    expect(out.map((m) => m.platformPostId)).toEqual(["111_222", "111_333", "111_444"]);
    const first = out[0]!;
    expect(first.source).toBe("FACEBOOK");
    expect(first.sourceUrl).toBe("https://www.facebook.com/111/posts/222");
    expect(first.engagements).toBe(15);
    expect(first.mentionedAt.toISOString()).toBe("2026-10-03T10:05:00.000Z");
    expect(first.authorName).toBeNull();
    expect(first.metadata).toMatchObject({ platform: "facebook", taggedPageId: "p1" });
    // A story-only post still has text.
    expect(out[2]!.content).toBe("Priya was at Acme HQ.");
  });

  it("a keyword that matches neither the text nor the Page name keeps only the matching posts", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, tagged));
    const out = await __listeningFetchers.facebook(ctx(["store opening"], [{ id: "c1", platform: "FACEBOOK", platformId: "p1", name: "Some Page" }]));
    expect(out.map((m) => m.platformPostId)).toEqual(["111_222"]);
  });

  it("descends to the minimal field set ONLY on a #100 nonexisting-field error, and a refused token contributes nothing", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(400, { error: { code: 100, message: "(#100) Tried accessing nonexisting field (reactions) on node type (PagePost)" } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [tagged.data[0]] }))
      .mockResolvedValueOnce(jsonResponse(400, { error: { code: 190, error_subcode: 460, message: "Error validating access token: session has been invalidated" } }));
    const rows = [
      { id: "c1", platform: "FACEBOOK", platformId: "p1", name: "Acme" },
      { id: "c2", platform: "FACEBOOK", platformId: "p2", name: "Acme Two" },
    ];
    const out = await __listeningFetchers.facebook(ctx(["acme"], rows));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(decodeURIComponent(String(fetchMock.mock.calls[1]![0]))).toContain("fields=id,message,story,created_time,tagged_time,permalink_url&");
    expect(out).toHaveLength(1);
    expect(out[0]!.engagements).toBe(15);
  });

  it("no Facebook channel ⇒ no request", async () => {
    const out = await __listeningFetchers.facebook(ctx(["acme"], [{ id: "c3", platform: "INSTAGRAM", platformId: "ig1", name: "acme" }]));
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchGoogleNews", () => {
  const rss = `<?xml version="1.0"?><rss><channel><item><title>Acme opens 50th store - Daily</title><link>https://news.google.com/rss/articles/CBMiAAA?oc=5</link><guid isPermaLink="false">CBMiAAA</guid><pubDate>Sat, 03 Oct 2026 18:21:13 GMT</pubDate><source url="https://daily.example">Daily</source></item></channel></rss>`;

  it("parses items into NEWS mentions, one request per keyword chunk, following Google's locale redirect", async () => {
    fetchMock.mockResolvedValue(new Response(rss, { status: 200 }));
    const out = await __listeningFetchers.news({ keywords: ["acme", "acme stores"], language: "en", organizationId: "o", queryId: "q", interactive: false, channels: async () => [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(decodeURIComponent(String(url))).toContain('q=acme OR "acme stores"&hl=en');
    expect((init as RequestInit).redirect).toBe("follow");
    expect(out).toHaveLength(1);
    expect(out[0]!).toMatchObject({ source: "NEWS", platformPostId: "CBMiAAA", authorName: "Daily", content: "Acme opens 50th store - Daily" });
  });

  it("logs a non-200 and an empty/HTML body instead of failing silently", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("blocked", { status: 429 }))
      .mockResolvedValueOnce(new Response("<html><body>Before you continue to Google</body></html>", { status: 200 }));
    const base = { language: "en", organizationId: "o", queryId: "q", interactive: false, channels: async () => [] };
    expect(await __listeningFetchers.news({ ...base, keywords: ["acme"] })).toEqual([]);
    expect(await __listeningFetchers.news({ ...base, keywords: ["acme"] })).toEqual([]);
    const warned = (console.warn as unknown as FetchMock).mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => /GoogleNews\] HTTP 429/.test(w))).toBe(true);
    expect(warned.some((w) => /GoogleNews\] 0 items .*Before you continue/.test(w))).toBe(true);
  });
});

// ── Reddit comments + YouTube (2026-10-05) ──────────────────────────────────


describe("fetchRedditMentions — comments", () => {
  beforeEach(() => {
    __resetListeningTokenCache();
    process.env.REDDIT_CLIENT_ID = "id";
    process.env.REDDIT_CLIENT_SECRET = "secret";
  });
  afterEach(() => {
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;
  });

  it("searches once, then opens the most-discussed matching posts and keeps relevant comments", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("access_token")) return jsonResponse(200, { access_token: "RT", expires_in: 3600 });
      if (url.includes("/search?")) {
        return jsonResponse(200, {
          data: {
            children: [
              { data: { id: "p1", name: "t3_p1", title: "Acme review", permalink: "/r/x/comments/p1/a/", subreddit: "x", num_comments: 12, created_utc: 1759600000 } },
              { data: { id: "p2", name: "t3_p2", title: "Quiet acme post", permalink: "/r/x/comments/p2/b/", subreddit: "x", num_comments: 0, created_utc: 1759600000 } },
            ],
          },
        });
      }
      if (url.includes("/comments/p1")) {
        return jsonResponse(200, [
          {},
          { data: { children: [{ kind: "t1", data: { id: "c1", name: "t1_c1", body: "love it", author: "u1", ups: 3, created_utc: 1759600100, permalink: "/r/x/comments/p1/a/c1/" } }] } },
        ]);
      }
      return jsonResponse(404, {});
    });
    const out = await __listeningFetchers.reddit(ctx(["acme"], []));
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes("/comments/"))).toEqual([
      "https://oauth.reddit.com/comments/p1?limit=100&depth=2&sort=new&raw_json=1",
    ]);
    expect(out.map((m) => m.platformPostId)).toEqual(["t3_p1", "t3_p2", "t1_c1"]);
    expect(out[2]!.metadata).toMatchObject({ kind: "comment", parentTitle: "Acme review" });
  });

  it("does nothing without Reddit credentials", async () => {
    delete process.env.REDDIT_CLIENT_ID;
    expect(await __listeningFetchers.reddit(ctx(["acme"], []))).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchYouTubeMentions", () => {
  const totals = new Map<string, number>();
  const counter = {
    async incrBy(day: string, units: number) {
      totals.set(day, (totals.get(day) ?? 0) + units);
      return totals.get(day)!;
    },
    async decrBy(day: string, units: number) {
      totals.set(day, (totals.get(day) ?? 0) - units);
    },
  };
  beforeEach(() => {
    totals.clear();
    __setYouTubeUnitCounter(counter);
  });
  afterEach(() => {
    __setYouTubeUnitCounter(null);
    delete process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_LISTENING_DAILY_UNITS;
  });

  const ytRoutes = (url: string) => {
    if (url.includes("/search?")) {
      return jsonResponse(200, {
        items: [
          { id: { videoId: "v1" }, snippet: { title: "Acme unboxing", channelTitle: "Tech", publishedAt: "2026-10-04T10:00:00Z" } },
          { id: { videoId: "v2" }, snippet: { title: "acme no comments", channelTitle: "T2", publishedAt: "2026-10-04T10:00:00Z" } },
        ],
      });
    }
    if (url.includes("/videos?")) {
      return jsonResponse(200, {
        items: [
          { id: "v1", statistics: { viewCount: "500", likeCount: "20", commentCount: "4" } },
          { id: "v2", statistics: { viewCount: "50", likeCount: "1", commentCount: "0" } },
        ],
      });
    }
    if (url.includes("/commentThreads?")) {
      return jsonResponse(200, { items: [{ id: "t", snippet: { topLevelComment: { id: "C1", snippet: { textOriginal: "so good", authorDisplayName: "@a", publishedAt: "2026-10-04T11:00:00Z" } } } }] });
    }
    return jsonResponse(404, {});
  };

  it("with a connected YouTube channel: search, stats, comments on videos that have them — and counts its units", async () => {
    fetchMock.mockImplementation(async (url: string) => ytRoutes(url));
    const rows = [{ id: "yt1", platform: "YOUTUBE", platformId: "UC", name: "Mine" }];
    const out = await __listeningFetchers.youtube({ ...ctx(["acme"], rows), interactive: true });
    const calls = fetchMock.mock.calls.map((c) => [String(c[0]).split("?")[0], (c[1] as any)?.headers?.Authorization]);
    expect(calls).toEqual([
      ["https://www.googleapis.com/youtube/v3/search", "Bearer tok-yt1"],
      ["https://www.googleapis.com/youtube/v3/videos", "Bearer tok-yt1"],
      ["https://www.googleapis.com/youtube/v3/commentThreads", "Bearer tok-yt1"],
    ]);
    expect(out.map((m) => m.platformPostId)).toEqual(["video:v1", "video:v2", "comment:C1"]);
    expect([...totals.values()][0]).toBe(102);
  });

  it("an API key is used as a query parameter, without a bearer token", async () => {
    process.env.YOUTUBE_API_KEY = "KEY";
    fetchMock.mockImplementation(async (url: string) => ytRoutes(url));
    await __listeningFetchers.youtube({ ...ctx(["acme"], []), interactive: true });
    expect(String(fetchMock.mock.calls[0]![0])).toContain("key=KEY");
    expect((fetchMock.mock.calls[0]![1] as any)?.headers?.Authorization).toBeUndefined();
  });

  it("stops before calling Google when the daily unit cap is reached", async () => {
    process.env.YOUTUBE_LISTENING_DAILY_UNITS = "50";
    fetchMock.mockImplementation(async (url: string) => ytRoutes(url));
    const out = await __listeningFetchers.youtube({ ...ctx(["acme"], [{ id: "yt1", platform: "YOUTUBE", platformId: "UC", name: "Mine" }]), interactive: true });
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no credential at all ⇒ nothing, no calls", async () => {
    const out = await __listeningFetchers.youtube({ ...ctx(["acme"], []), interactive: true });
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls over to the next channel on a 401", async () => {
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (init?.headers?.Authorization === "Bearer tok-dead") return jsonResponse(401, { error: { code: 401 } });
      return ytRoutes(url);
    });
    const rows = [
      { id: "dead", platform: "YOUTUBE", platformId: "UC1", name: "Old" },
      { id: "yt2", platform: "YOUTUBE", platformId: "UC2", name: "New" },
    ];
    const out = await __listeningFetchers.youtube({ ...ctx(["acme"], rows), interactive: true });
    expect(out.length).toBe(3);
  });

  it("Google's quotaExceeded stops YouTube for the day", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(403, { error: { errors: [{ reason: "quotaExceeded" }] } }));
    const rows = [{ id: "yt1", platform: "YOUTUBE", platformId: "UC", name: "Mine" }];
    await __listeningFetchers.youtube({ ...ctx(["acme"], rows), interactive: true });
    fetchMock.mockClear();
    await __listeningFetchers.youtube({ ...ctx(["acme"], rows), interactive: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Public sources (2026-10-05) ────────────────────────────────────────────

describe("public sources", () => {
  afterEach(() => {
    delete process.env.LISTENING_MASTODON_INSTANCES;
    __resetGdeltGate();
  });

  it("Hacker News: one request per keyword, at most 5", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { hits: [] }));
    await __listeningFetchers.hackernews(ctx(["a1", "a2", "a3", "a4", "a5", "a6"], []));
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/^https:\/\/hn\.algolia\.com\/api\/v1\/search_by_date\?query=a1/);
    expect((fetchMock.mock.calls[0]![1] as any).headers["User-Agent"]).toMatch(/PostAutomation/);
  });

  it("Mastodon: each configured instance × each keyword-as-hashtag", async () => {
    process.env.LISTENING_MASTODON_INSTANCES = "mastodon.social,fosstodon.org";
    fetchMock.mockImplementation(async () => jsonResponse(200, []));
    await __listeningFetchers.mastodon(ctx(["Acme", "Acme Phone", "x"], []));
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://mastodon.social/api/v1/timelines/tag/acme?limit=40",
      "https://mastodon.social/api/v1/timelines/tag/acmephone?limit=40",
      "https://fosstodon.org/api/v1/timelines/tag/acme?limit=40",
      "https://fosstodon.org/api/v1/timelines/tag/acmephone?limit=40",
    ]);
  });

  it("a failing source logs and returns nothing (never throws)", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("network down");
    });
    await expect(__listeningFetchers.bluesky(ctx(["acme"], []))).resolves.toEqual([]);
    fetchMock.mockImplementation(async () => jsonResponse(503, {}));
    await expect(__listeningFetchers.lemmy(ctx(["acme"], []))).resolves.toEqual([]);
  });

  it("GDELT: a 200 that isn't JSON (its rate-limit text) is skipped", async () => {
    fetchMock.mockImplementation(async () => new Response("Please limit requests to one every 5 seconds", { status: 200 }));
    await expect(__listeningFetchers.gdelt(ctx(["acme"], []))).resolves.toEqual([]);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/^https:\/\/api\.gdeltproject\.org\/api\/v2\/doc\/doc\?query=acme/);
  });

  it("news = Google News + Bing News + GDELT", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("https://news.google.com")) {
        return new Response("<rss><channel><item><title>G headline</title><link>https://g/1</link><guid>g1</guid></item></channel></rss>", { status: 200 });
      }
      if (url.startsWith("https://www.bing.com")) {
        return new Response("<rss><channel><item><title>B headline</title><link>https://b.example/1</link><pubDate>Mon, 05 Oct 2026 09:55:00 GMT</pubDate></item></channel></rss>", { status: 200 });
      }
      return jsonResponse(200, { articles: [{ url: "https://d.example/1", title: "D headline", seendate: "20261005T171500Z", domain: "d.example" }] });
    });
    const out = await __listeningFetchers.allNews(ctx(["acme"], []));
    expect(out.map((m) => m.content).sort()).toEqual(["B headline", "D headline", "G headline"]);
    expect(out.every((m) => m.source === "NEWS")).toBe(true);
  });
});
