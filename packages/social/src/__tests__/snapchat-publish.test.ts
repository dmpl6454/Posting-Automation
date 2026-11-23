import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
vi.mock("@postautomation/db", () => ({}));
vi.mock("@postautomation/social-scrapers", () => ({
  scrapeSnapchatSpotlightEngagement: vi.fn(async () => null),
}));

import { SnapchatProvider } from "../providers/snapchat.provider";
import {
  chooseSnapSurface,
  encryptedParts,
  readSnapStats,
  snapDescription,
  snapErrorMessage,
} from "../utils/snapchat-publish";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function* chunks(buf: Buffer, size: number) {
  for (let i = 0; i < buf.length; i += size) yield new Uint8Array(buf.subarray(i, i + size));
}

describe("snapchat posting helpers", () => {
  it("encrypts in ordered parts that decrypt back to the original (AES-256-CBC, PKCS#7)", async () => {
    const plain = randomBytes(100_003);
    const key = randomBytes(32);
    const iv = randomBytes(16);
    const parts: Buffer[] = [];
    for await (const p of encryptedParts(chunks(plain, 7_777), key, iv, 16_384)) parts.push(p);

    expect(parts.length).toBe(Math.ceil(100_016 / 16_384));
    expect(parts.slice(0, -1).every((p) => p.length === 16_384)).toBe(true);
    const joined = Buffer.concat(parts);
    // Byte-identical to a one-shot encryption (what `openssl enc -aes-256-cbc` makes).
    const c = createCipheriv("aes-256-cbc", key, iv);
    expect(joined.equals(Buffer.concat([c.update(plain), c.final()]))).toBe(true);
    const d = createDecipheriv("aes-256-cbc", key, iv);
    expect(Buffer.concat([d.update(joined), d.final()]).equals(plain)).toBe(true);
  });

  it("chooses the surface: STORY format → Story, image → Story, video → Spotlight", () => {
    expect(chooseSnapSurface({ format: "STORY", isVideo: true })).toBe("STORY");
    expect(chooseSnapSurface({ format: undefined, isVideo: false })).toBe("STORY");
    expect(chooseSnapSurface({ format: "REEL", isVideo: true })).toBe("SPOTLIGHT");
  });

  it("trims a long description at a word boundary to ≤160 characters", () => {
    const long = "word ".repeat(60).trim();
    const out = snapDescription(long);
    expect(Array.from(out).length).toBeLessThanOrEqual(160);
    expect(out.endsWith("…")).toBe(true);
    expect(snapDescription("  short  ")).toBe("short");
  });

  it("explains a not-allowlisted app instead of returning raw JSON", () => {
    expect(snapErrorMessage({ error_code: "AUTHORIZATION_PERMISSION_DENIED" }, 403)).toMatch(/not yet approved/);
  });

  it("reads lifetime stats (string values, DEFAULT dimension only)", () => {
    const m = readSnapStats({
      assets: [
        {
          sub_request_status: "SUCCESS",
          timeseries: [
            {
              fields: [
                { field: { field_name: "SPOTLIGHT_VIEWS", report_dimension: "DEFAULT" }, stats: [{ value: "1234" }] },
                { field: { field_name: "SPOTLIGHT_SHARES" }, stats: [{ value: "0" }] },
                { field: { field_name: "VIEWS", report_dimension: "AGE" }, stats: [{ value: "9" }] },
              ],
            },
          ],
        },
      ],
    });
    expect(m.get("SPOTLIGHT_VIEWS")).toBe(1234);
    expect(m.get("SPOTLIGHT_SHARES")).toBe(0);
    expect(m.has("VIEWS")).toBe(false);
  });
});

describe("SnapchatProvider.publishPost", () => {
  const snap = new SnapchatProvider();
  const tokens = { accessToken: "tok" };
  const PROFILE = "prof-1";
  const ADD = `/us/v1/public_profiles/${PROFILE}/media/m-1/multipart-upload`;
  let calls: { url: string; init: any }[];

  function route(overrides: Record<string, () => Response> = {}) {
    calls = [];
    mockFetch.mockImplementation(async (url: string, init: any) => {
      calls.push({ url, init });
      for (const [k, fn] of Object.entries(overrides)) if (url.endsWith(k)) return fn();
      if (url.endsWith("/media")) return json({ request_status: "SUCCESS", media_id: "m-1", add_path: ADD, finalize_path: ADD });
      if (url.startsWith("https://cdn.example.com/")) return new Response(randomBytes(5000), { headers: { "content-length": "5000" } });
      if (url.endsWith("multipart-upload")) return json({ request_status: "SUCCESS" });
      if (url.endsWith("/spotlights")) return json({ request_status: "SUCCESS", spotlight_id: "S-9" });
      if (url.endsWith("/stories")) return json({ request_status: "SUCCESS" });
      throw new Error(`unexpected ${url}`);
    });
  }

  beforeEach(() => vi.clearAllMocks());

  it("posts a video as a Spotlight: create media → ADD → FINALIZE → checkpoint → spotlights", async () => {
    route();
    const checkpoints: any[] = [];
    const res = await snap.publishPost(tokens, {
      content: "hello #world",
      mediaUrls: ["https://cdn.example.com/v.mp4"],
      mediaTypes: ["video/mp4"],
      metadata: { snapProfileId: PROFILE },
      onCheckpoint: async (p) => {
        checkpoints.push({ ...p, callsSoFar: calls.length });
      },
    });

    expect(res).toMatchObject({ platformPostId: "S-9", url: "https://www.snapchat.com/spotlight/S-9" });
    const create = calls.find((c) => c.url.endsWith("/media"))!;
    const created = JSON.parse(create.init.body);
    expect(created.type).toBe("VIDEO");
    expect(Buffer.from(created.key, "base64")).toHaveLength(32);
    expect(Buffer.from(created.iv, "base64")).toHaveLength(16);

    const add = calls.find((c) => c.init?.body instanceof FormData && c.init.body.get("action") === "ADD")!;
    expect(add.url).toBe(`https://businessapi.snapchat.com${ADD}`);
    expect(add.init.body.get("part_number")).toBe("1");
    expect((add.init.body.get("file") as Blob).size).toBe(5008); // 5000 bytes + PKCS#7 padding

    // The checkpoint lands BEFORE the spotlight create.
    const postIdx = calls.findIndex((c) => c.url.endsWith("/spotlights"));
    expect(checkpoints[0].snapPublish).toMatchObject({ mediaId: "m-1", surface: "SPOTLIGHT" });
    expect(checkpoints[0].callsSoFar).toBe(postIdx);
    expect(JSON.parse(calls[postIdx]!.init.body)).toEqual({ media_id: "m-1", description: "hello #world", locale: "en_US" });
    expect(calls[postIdx]!.url).toBe(`https://businessapi.snapchat.com/v1/public_profiles/${PROFILE}/spotlights`);
  });

  it("posts an image as a Story with only the media id, and returns a prefixed id", async () => {
    route();
    const res = await snap.publishPost(tokens, {
      content: "caption",
      mediaUrls: ["https://cdn.example.com/p.jpg"],
      mediaTypes: ["image/jpeg"],
      metadata: { snapProfileId: PROFILE, channelUsername: "brand" },
    });
    expect(res.platformPostId).toBe("story:m-1");
    expect(res.url).toBe("https://www.snapchat.com/add/brand");
    const story = calls.find((c) => c.url.endsWith("/stories"))!;
    expect(JSON.parse(story.init.body)).toEqual({ media_id: "m-1" });
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/media"))!.init.body).type).toBe("IMAGE");
  });

  it("an unknown outcome (5xx) parks the post as 'needs check', never a plain failure", async () => {
    route({ "/spotlights": () => json({ request_status: "ERROR" }, 502) });
    await expect(
      snap.publishPost(tokens, {
        content: "x",
        mediaUrls: ["https://cdn.example.com/v.mp4"],
        mediaTypes: ["video/mp4"],
        metadata: { snapProfileId: PROFILE },
      })
    ).rejects.toMatchObject({ isAmbiguousPublish: true });
  });

  it("a definite refusal clears the dispatch stamp so a retry may post", async () => {
    route({ "/spotlights": () => json({ request_status: "ERROR", error_code: "VALIDATION_ERROR_INVALID_SPOTLIGHT_LINK" }, 400) });
    const checkpoints: any[] = [];
    const err = await snap
      .publishPost(tokens, {
        content: "x",
        mediaUrls: ["https://cdn.example.com/v.mp4"],
        mediaTypes: ["video/mp4"],
        metadata: { snapProfileId: PROFILE },
        onCheckpoint: (p) => void checkpoints.push(p),
      })
      .catch((e) => e);
    expect(err.isAmbiguousPublish).toBeUndefined();
    expect(checkpoints.at(-1).snapPublish.dispatchedAt).toBeNull();
  });

  it("a retry after a dispatched Story never posts again", async () => {
    route();
    await expect(
      snap.publishPost(tokens, {
        content: "",
        mediaUrls: ["https://cdn.example.com/p.jpg"],
        mediaTypes: ["image/jpeg"],
        metadata: { snapProfileId: PROFILE, snapPublish: { mediaId: "m-0", surface: "STORY", dispatchedAt: new Date().toISOString() } },
      })
    ).rejects.toMatchObject({ isAmbiguousPublish: true });
    expect(calls.some((c) => c.url.endsWith("/media") || c.url.endsWith("/stories"))).toBe(false);
  });

  it("a retry after a dispatched Spotlight adopts it when the listing shows exactly one match", async () => {
    const since = new Date().toISOString();
    route({
      "/spotlights?limit=20": () =>
        json({
          request_status: "SUCCESS",
          spotlights: [{ spotlight: { id: "S-LIVE", created_at: since, caption: "hello" } }],
        }),
    });
    const res = await snap.publishPost(tokens, {
      content: "hello",
      mediaUrls: ["https://cdn.example.com/v.mp4"],
      mediaTypes: ["video/mp4"],
      metadata: { snapProfileId: PROFILE, snapPublish: { mediaId: "m-0", surface: "SPOTLIGHT", dispatchedAt: since } },
    });
    expect(res.platformPostId).toBe("S-LIVE");
    expect(calls.some((c) => c.url.endsWith("/media"))).toBe(false);
  });

  it("refuses more than one media item", async () => {
    route();
    await expect(
      snap.publishPost(tokens, { content: "", mediaUrls: ["a", "b"], metadata: { snapProfileId: PROFILE } })
    ).rejects.toThrow(/single image or video/);
  });
});

describe("SnapchatProvider analytics + delete", () => {
  const snap = new SnapchatProvider();
  const tokens = { accessToken: "tok", metadata: { snapProfileId: "prof-1" } };
  beforeEach(() => vi.clearAllMocks());

  it("maps Spotlight stats: views, uniques → reach, favorites → likes, shares", async () => {
    mockFetch.mockResolvedValueOnce(
      json({
        request_status: "SUCCESS",
        assets: [
          {
            sub_request_status: "SUCCESS",
            timeseries: [
              {
                fields: [
                  { field: { field_name: "SPOTLIGHT_VIEWS" }, stats: [{ value: "1000" }] },
                  { field: { field_name: "SPOTLIGHT_UNIQUES" }, stats: [{ value: "800" }] },
                  { field: { field_name: "SPOTLIGHT_FAVORITES" }, stats: [{ value: "40" }] },
                  { field: { field_name: "SPOTLIGHT_SHARES" }, stats: [{ value: "10" }] },
                ],
              },
            ],
          },
        ],
      })
    );
    const a = await snap.getPostAnalytics(tokens, "S-9");
    expect(mockFetch.mock.calls[0]![0]).toBe(
      "https://businessapi.snapchat.com/v1/public_profiles/prof-1/spotlights/S-9/stats"
    );
    expect(a).toMatchObject({ views: 1000, reach: 800, likes: 40, shares: 10, source: "api" });
    expect(a?.engagementRate).toBeCloseTo(0.05);
    expect(a?.metricsAvailable).toMatchObject({ impressions: false, views: true, reach: true, comments: false });
  });

  it("a Story has nothing to measure; a refused stats call falls back to the scraper (null here)", async () => {
    await expect(snap.getPostAnalytics(tokens, "story:m-1")).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    mockFetch.mockResolvedValueOnce(json({ error_code: "AUTHORIZATION_PERMISSION_DENIED" }, 403));
    await expect(snap.getPostAnalytics(tokens, "S-9")).resolves.toBeNull();
  });

  it("deletes a Spotlight; a Story cannot be deleted through the API", async () => {
    mockFetch.mockResolvedValueOnce(json({ request_status: "SUCCESS" }));
    await snap.deletePost(tokens, "S-9");
    expect(mockFetch.mock.calls[0]![0]).toBe("https://businessapi.snapchat.com/v1/public_profiles/prof-1/spotlights/S-9");
    expect(mockFetch.mock.calls[0]![1].method).toBe("DELETE");
    await expect(snap.deletePost(tokens, "story:m-1")).rejects.toThrow(/Snapchat app/);
  });
});
