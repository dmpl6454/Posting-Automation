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

import { __listeningFetchers } from "../listening-sync.worker";

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
    const out = await __listeningFetchers.news({ keywords: ["acme", "acme stores"], language: "en", organizationId: "o", channels: async () => [] });
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
    const base = { language: "en", organizationId: "o", channels: async () => [] };
    expect(await __listeningFetchers.news({ ...base, keywords: ["acme"] })).toEqual([]);
    expect(await __listeningFetchers.news({ ...base, keywords: ["acme"] })).toEqual([]);
    const warned = (console.warn as unknown as FetchMock).mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => /GoogleNews\] HTTP 429/.test(w))).toBe(true);
    expect(warned.some((w) => /GoogleNews\] 0 items .*Before you continue/.test(w))).toBe(true);
  });
});
