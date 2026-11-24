import { describe, it, expect, vi, afterEach } from "vitest";
import { InstagramProvider } from "../providers/instagram.provider";
import {
  buildImageUserTags,
  buildReelUserTags,
  imageTagPosition,
  readPostUserTags,
} from "../utils/instagram-user-tags";

/**
 * Tagging people on Instagram FEED posts and REELS (2026-11-24).
 *
 * Locks: a photo sends usernames WITH x/y (Meta: "required for images"); a reel
 * sends bare usernames; a carousel tags the FIRST PHOTO child only; untagged
 * requests are byte-identical; a rejected tag fails with a message naming it.
 */

const IG_USER = "17841400000000000";

interface Call {
  url: string;
  method: string;
  raw?: string;
  body?: any;
}

function mockGraph(handler: (url: string, method: string, body: any) => { ok: boolean; body: any }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const raw = typeof init?.body === "string" ? init.body : undefined;
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ url: String(url), method, raw, body });
      const res = handler(String(url), method, body);
      return { ok: res.ok, status: res.ok ? 200 : 400, json: async () => res.body, headers: { get: () => null } } as any;
    })
  );
  return calls;
}

function instantSleep() {
  vi.stubGlobal("setTimeout", ((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
}

let childSeq = 0;
const happyGraph = () =>
  mockGraph((url, method) => {
    if (url.includes("/media_publish")) return { ok: true, body: { id: "9001" } };
    if (method === "POST" && url.includes(`/${IG_USER}/media`)) return { ok: true, body: { id: `c-${++childSeq}` } };
    if (url.includes("status_code")) return { ok: true, body: { status_code: "FINISHED" } };
    return { ok: true, body: {} };
  });

const creates = (calls: Call[]) =>
  calls.filter((c) => c.method === "POST" && c.url.includes(`/${IG_USER}/media`) && !c.url.includes("media_publish"));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("instagram user tag helpers", () => {
  it("cleans stored usernames: strips @, drops invalid, dedupes case-insensitively, caps at 20", () => {
    const many = Array.from({ length: 25 }, (_, i) => `user${i}`);
    expect(readPostUserTags({ instagramUserTags: { usernames: ["@natgeo", "NatGeo", "bad name", "nasa"] } })).toEqual([
      "natgeo",
      "nasa",
    ]);
    expect(readPostUserTags({ instagramUserTags: { usernames: many } })).toHaveLength(20);
    expect(readPostUserTags({})).toEqual([]);
    expect(readPostUserTags(null)).toEqual([]);
  });

  it("returns null when untagged, so no user_tags key is sent", () => {
    expect(buildImageUserTags({})).toBeNull();
    expect(buildReelUserTags({ instagramUserTags: { usernames: [] } })).toBeNull();
  });

  it("lays photo tags out inside 0..1 without two tags on the same spot", () => {
    for (const n of [1, 2, 3, 4, 7, 20]) {
      const seen = new Set<string>();
      for (let i = 0; i < n; i++) {
        const { x, y } = imageTagPosition(i, n);
        expect(x).toBeGreaterThan(0);
        expect(x).toBeLessThan(1);
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(1);
        seen.add(`${x},${y}`);
      }
      expect(seen.size).toBe(n);
    }
    expect(imageTagPosition(0, 1)).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe("Instagram feed/reel/carousel containers with tags", () => {
  it("photo → user_tags with x/y", async () => {
    const calls = happyGraph();
    instantSleep();
    await new InstagramProvider().publishPost(
      { accessToken: "t" },
      {
        content: "hello",
        mediaUrls: ["https://cdn.example.com/a.jpg"],
        mediaTypes: ["image/jpeg"],
        metadata: { igUserId: IG_USER, instagramUserTags: { usernames: ["natgeo", "nasa"] } },
      }
    );
    expect(creates(calls)[0]!.body).toEqual({
      caption: "hello",
      image_url: "https://cdn.example.com/a.jpg",
      user_tags: [
        { username: "natgeo", x: 0.33, y: 0.5 },
        { username: "nasa", x: 0.67, y: 0.5 },
      ],
      access_token: "t",
    });
  });

  it("reel → user_tags without coordinates", async () => {
    const calls = happyGraph();
    instantSleep();
    await new InstagramProvider().publishPost(
      { accessToken: "t" },
      {
        content: "reel",
        mediaUrls: ["https://cdn.example.com/a.mp4"],
        mediaTypes: ["video/mp4"],
        metadata: { igUserId: IG_USER, instagramUserTags: { usernames: ["natgeo"] } },
      }
    );
    expect(creates(calls)[0]!.body).toEqual({
      caption: "reel",
      video_url: "https://cdn.example.com/a.mp4",
      media_type: "REELS",
      user_tags: [{ username: "natgeo" }],
      access_token: "t",
    });
  });

  it("an untagged photo request is byte-identical to the pre-feature body", async () => {
    const calls = happyGraph();
    instantSleep();
    await new InstagramProvider().publishPost(
      { accessToken: "t" },
      { content: "hi", mediaUrls: ["https://cdn.example.com/a.jpg"], mediaTypes: ["image/jpeg"], metadata: { igUserId: IG_USER } }
    );
    expect(creates(calls)[0]!.raw).toBe(
      JSON.stringify({ caption: "hi", image_url: "https://cdn.example.com/a.jpg", access_token: "t" })
    );
  });

  it("carousel → tags only on the first PHOTO child, never on the parent or a video", async () => {
    const calls = happyGraph();
    instantSleep();
    await new InstagramProvider().publishPost(
      { accessToken: "t" },
      {
        content: "set",
        mediaUrls: ["https://cdn.example.com/v.mp4", "https://cdn.example.com/a.jpg", "https://cdn.example.com/b.jpg"],
        mediaTypes: ["video/mp4", "image/jpeg", "image/jpeg"],
        metadata: { igUserId: IG_USER, instagramUserTags: { usernames: ["natgeo"] } },
      }
    );
    const bodies = creates(calls).map((c) => c.body);
    const children = bodies.filter((b) => b.is_carousel_item);
    const parent = bodies.find((b) => b.media_type === "CAROUSEL");
    expect(children.find((b) => b.video_url)?.user_tags).toBeUndefined();
    expect(children.find((b) => b.image_url?.endsWith("a.jpg"))?.user_tags).toEqual([
      { username: "natgeo", x: 0.5, y: 0.5 },
    ]);
    expect(children.find((b) => b.image_url?.endsWith("b.jpg"))?.user_tags).toBeUndefined();
    expect(parent.user_tags).toBeUndefined();
  });

  it("a story made by the per-channel picker uses the post's tags", async () => {
    const calls = happyGraph();
    instantSleep();
    await new InstagramProvider().publishPost(
      { accessToken: "t" },
      {
        content: "",
        mediaUrls: ["https://cdn.example.com/a.mp4"],
        mediaTypes: ["video/mp4"],
        metadata: { igUserId: IG_USER, format: "STORY", instagramUserTags: { usernames: ["natgeo"] } },
        onCheckpoint: () => {},
      }
    );
    expect(creates(calls)[0]!.body.user_tags).toEqual([{ username: "natgeo" }]);
  });

  it("a rejected tag fails before publishing, naming the tag", async () => {
    const calls = mockGraph((url, method) => {
      if (method === "POST" && url.includes(`/${IG_USER}/media`)) {
        return { ok: false, body: { error: { message: "Invalid user tag: the user does not exist", code: 100 } } };
      }
      return { ok: true, body: {} };
    });
    instantSleep();
    await expect(
      new InstagramProvider().publishPost(
        { accessToken: "t" },
        {
          content: "hello",
          mediaUrls: ["https://cdn.example.com/a.jpg"],
          mediaTypes: ["image/jpeg"],
          metadata: { igUserId: IG_USER, instagramUserTags: { usernames: ["ghostuser"] } },
        }
      )
    ).rejects.toThrow(/rejected a tagged account \(@ghostuser\)/);
    expect(calls.some((c) => c.url.includes("media_publish"))).toBe(false);
  });
});
