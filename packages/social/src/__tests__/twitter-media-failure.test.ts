import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { TwitterProvider } from "../providers/twitter.provider";

const realFetch = global.fetch;
const origId = process.env.TWITTER_CLIENT_ID;
const origSecret = process.env.TWITTER_CLIENT_SECRET;

beforeAll(() => {
  process.env.TWITTER_CLIENT_ID = "consumer-key";
  process.env.TWITTER_CLIENT_SECRET = "consumer-secret";
});

afterAll(() => {
  if (origId === undefined) delete process.env.TWITTER_CLIENT_ID;
  else process.env.TWITTER_CLIENT_ID = origId;
  if (origSecret === undefined) delete process.env.TWITTER_CLIENT_SECRET;
  else process.env.TWITTER_CLIENT_SECRET = origSecret;
});

afterEach(() => {
  global.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const tokens = { accessToken: "at", refreshToken: "rt" };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const isHead = (init?: any) => init?.method === "HEAD";
const isUpload = (u: string) => u.startsWith("https://upload.twitter.com/");
const isTweet = (u: string) => u === "https://api.twitter.com/2/tweets";
const bodyCommand = (init?: any): string | null => {
  if (typeof init?.body === "string") {
    return new URLSearchParams(init.body).get("command");
  }
  if (init?.body instanceof FormData) {
    const c = init.body.get("command");
    return typeof c === "string" ? c : "IMAGE_UPLOAD";
  }
  return null;
};

describe("TwitterProvider.publishPost — media failure must not silently post a text-only tweet", () => {
  it("THROWS when the only (video) media upload fails at INIT — no tweet is posted", async () => {
    let tweetPosted = false;
    global.fetch = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u.startsWith("https://s3.example.com/") && isHead(init)) {
        return new Response(null, {
          status: 200,
          headers: { "content-length": String(600 * 1024 * 1024), "content-type": "video/mp4" },
        });
      }
      if (isUpload(u) && bodyCommand(init) === "INIT") {
        return new Response('{"errors":[{"message":"File size exceeds limit"}]}', { status: 400 });
      }
      if (isTweet(u)) {
        tweetPosted = true;
        return jsonResponse({ data: { id: "SHOULD_NOT_HAPPEN" } });
      }
      throw new Error(`Unexpected request: ${u}`);
    }) as any;

    const provider = new TwitterProvider();
    await expect(
      provider.publishPost(tokens, {
        content: "my caption",
        mediaUrls: ["https://s3.example.com/big.mp4"],
        mediaTypes: ["video/mp4"],
      })
    ).rejects.toThrow(/Twitter media upload failed \(1\/1\).*INIT failed/s);

    expect(tweetPosted).toBe(false);
  });

  it("THROWS when a VIDEO fails even if an image succeeded — a video post must never degrade to image-only", async () => {
    let tweetPosted = false;
    global.fetch = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u === "https://s3.example.com/pic.jpg" && isHead(init)) {
        return new Response(null, {
          status: 200,
          headers: { "content-length": "100", "content-type": "image/jpeg" },
        });
      }
      if (u === "https://s3.example.com/pic.jpg") {
        return new Response(new Uint8Array(100), { status: 200 });
      }
      if (u === "https://s3.example.com/vid.mp4" && isHead(init)) {
        return new Response(null, {
          status: 200,
          headers: { "content-length": String(600 * 1024 * 1024), "content-type": "video/mp4" },
        });
      }
      if (isUpload(u) && bodyCommand(init) === "INIT") {
        return new Response('{"errors":[{"message":"too big"}]}', { status: 400 });
      }
      if (isUpload(u) && bodyCommand(init) === "IMAGE_UPLOAD") {
        return jsonResponse({ media_id_string: "M1" });
      }
      if (isUpload(u)) {
        // image upload FormData has no "command" field
        return jsonResponse({ media_id_string: "M1" });
      }
      if (isTweet(u)) {
        tweetPosted = true;
        return jsonResponse({ data: { id: "SHOULD_NOT_HAPPEN" } });
      }
      throw new Error(`Unexpected request: ${u}`);
    }) as any;

    const provider = new TwitterProvider();
    await expect(
      provider.publishPost(tokens, {
        content: "caption",
        mediaUrls: ["https://s3.example.com/pic.jpg", "https://s3.example.com/vid.mp4"],
        mediaTypes: ["image/jpeg", "video/mp4"],
      })
    ).rejects.toThrow(/Twitter media upload failed/);
    expect(tweetPosted).toBe(false);
  });

  it("keeps the lenient path for PARTIAL image failure — tweet posts with the surviving media_id", async () => {
    let tweetBody: any = null;
    global.fetch = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith(".jpg") && isHead(init)) {
        return new Response(null, {
          status: 200,
          headers: { "content-length": "100", "content-type": "image/jpeg" },
        });
      }
      if (u === "https://s3.example.com/a.jpg") {
        return new Response(null, { status: 404 }); // this image's fetch fails
      }
      if (u === "https://s3.example.com/b.jpg") {
        return new Response(new Uint8Array(100), { status: 200 });
      }
      if (isUpload(u)) {
        return jsonResponse({ media_id_string: "M2" });
      }
      if (isTweet(u)) {
        tweetBody = JSON.parse(String(init?.body));
        return jsonResponse({ data: { id: "T1" } });
      }
      throw new Error(`Unexpected request: ${u}`);
    }) as any;

    const provider = new TwitterProvider();
    const result = await provider.publishPost(tokens, {
      content: "caption",
      mediaUrls: ["https://s3.example.com/a.jpg", "https://s3.example.com/b.jpg"],
      mediaTypes: ["image/jpeg", "image/jpeg"],
    });

    expect(result.platformPostId).toBe("T1");
    expect(tweetBody?.media?.media_ids).toEqual(["M2"]);
  });
});

describe("TwitterProvider video STATUS poll — respects check_after_secs and scales the deadline", () => {
  it("waits check_after_secs between polls (8s from FINALIZE, then 10s from STATUS) instead of a fixed 3s", async () => {
    vi.useFakeTimers();
    const statusTimes: number[] = [];
    let statusCount = 0;
    let tweetBody: any = null;

    global.fetch = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u.startsWith("https://s3.example.com/") && isHead(init)) {
        return new Response(null, {
          status: 200,
          headers: { "content-length": String(10 * 1024 * 1024), "content-type": "video/mp4" },
        });
      }
      if (u.startsWith("https://s3.example.com/")) {
        // ranged APPEND chunk fetch
        return new Response(new Uint8Array(4), { status: 206 });
      }
      if (isUpload(u) && u.includes("command=STATUS")) {
        statusTimes.push(Date.now());
        statusCount++;
        return statusCount === 1
          ? jsonResponse({ processing_info: { state: "in_progress", check_after_secs: 10 } })
          : jsonResponse({ processing_info: { state: "succeeded" } });
      }
      const cmd = bodyCommand(init);
      if (isUpload(u) && cmd === "INIT") {
        return jsonResponse({ media_id_string: "MV" });
      }
      if (isUpload(u) && cmd === "APPEND") {
        return jsonResponse({}, 200);
      }
      if (isUpload(u) && cmd === "FINALIZE") {
        return jsonResponse({
          media_id_string: "MV",
          processing_info: { state: "pending", check_after_secs: 8 },
        });
      }
      if (isTweet(u)) {
        tweetBody = JSON.parse(String(init?.body));
        return jsonResponse({ data: { id: "T9" } });
      }
      throw new Error(`Unexpected request: ${u}`);
    }) as any;

    const flush = async () => {
      for (let i = 0; i < 80; i++) await Promise.resolve();
    };

    const provider = new TwitterProvider();
    const t0 = Date.now();
    const promise = provider.publishPost(tokens, {
      content: "big video",
      mediaUrls: ["https://s3.example.com/vid.mp4"],
      mediaTypes: ["video/mp4"],
    });

    await flush(); // probe → INIT → APPENDs → FINALIZE; now parked on the 8s sleep
    expect(statusCount).toBe(0);

    // The OLD fixed 3s cadence must NOT fire — X said check_after_secs: 8
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(statusCount).toBe(0);

    await vi.advanceTimersByTimeAsync(5000); // t = 8s → first poll
    await flush();
    expect(statusCount).toBe(1);
    expect(statusTimes[0]! - t0).toBe(8000);

    // Next hint is 10s — 3s later must still be quiet
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(statusCount).toBe(1);

    await vi.advanceTimersByTimeAsync(7000); // t = 18s → second poll → succeeded
    await flush();
    expect(statusCount).toBe(2);
    expect(statusTimes[1]! - statusTimes[0]!).toBe(10000);

    const result = await promise;
    expect(result.platformPostId).toBe("T9");
    expect(tweetBody?.media?.media_ids).toEqual(["MV"]);
  });
});
