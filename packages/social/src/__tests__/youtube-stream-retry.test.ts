import { describe, it, expect, vi, afterEach } from "vitest";
import { YouTubeProvider, YT_STREAM_THRESHOLD_BYTES } from "../providers/youtube.provider";

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

const tokens = { accessToken: "yt-token" };
const MB = 1024 * 1024;
const SESSION_URL = "https://yt-upload.example.com/session";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const videoPayload = (url: string) => ({
  content: "a video",
  mediaUrls: [url],
  mediaTypes: ["video/mp4"],
  metadata: {}, // not a Short — no ffprobe involved
});

interface ChunkPut {
  contentRange: string;
}

// Builds a fetch mock for the streamed-upload chain. `putHandler` decides the
// outcome of each DATA chunk PUT (Content-Range "bytes N-M/T");
// `offsetHandler` handles the resumable offset query ("bytes */T").
function mockStreamedUpload(opts: {
  totalBytes: number;
  putHandler: (put: ChunkPut, dataPutIndex: number) => Response | Error;
  offsetHandler?: (queryIndex: number) => Response;
  onOffsetQuery?: () => void;
  chunkPuts: ChunkPut[];
  offsetQueries: string[];
}) {
  let dataPutIndex = 0;
  let offsetQueryIndex = 0;
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith("https://s3.example.com/") && init?.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-length": String(opts.totalBytes), "content-type": "video/mp4" },
      });
    }
    if (u.startsWith("https://s3.example.com/")) {
      // ranged chunk fetch — body size is irrelevant to the mocked upload
      return new Response(new Uint8Array(4), { status: 206 });
    }
    if (u.includes("googleapis.com/upload/youtube/v3/videos")) {
      return new Response(JSON.stringify({}), { status: 200, headers: { location: SESSION_URL } });
    }
    if (u === SESSION_URL) {
      const contentRange = String(init?.headers?.["Content-Range"] ?? "");
      if (contentRange.startsWith("bytes */")) {
        opts.offsetQueries.push(contentRange);
        return (opts.offsetHandler ?? (() => new Response(null, { status: 308 })))(
          offsetQueryIndex++
        );
      }
      const put = { contentRange };
      opts.chunkPuts.push(put);
      const out = opts.putHandler(put, dataPutIndex++);
      if (out instanceof Error) throw out;
      return out;
    }
    throw new Error(`Unexpected request: ${u}`);
  }) as any;
}

describe("YouTube streamed (>64MB) upload — bounded per-chunk retry with resume-at-offset", () => {
  it("recovers from one transient 'fetch failed' by querying the session offset and resuming there", async () => {
    const totalBytes = 80 * MB; // > YT_STREAM_THRESHOLD_BYTES → CHUNK_SIZE 16MB → 5 chunks
    expect(totalBytes).toBeGreaterThan(YT_STREAM_THRESHOLD_BYTES);

    const chunkPuts: ChunkPut[] = [];
    const offsetQueries: string[] = [];

    mockStreamedUpload({
      totalBytes,
      chunkPuts,
      offsetQueries,
      putHandler: (_put, i) => {
        if (i === 1) return new TypeError("fetch failed"); // transient blip on chunk 2
        if (i === 5) return jsonResponse({ id: "yt123" }); // last chunk (after 1 retry) completes
        return new Response(null, { status: 308 });
      },
      offsetHandler: () =>
        // Google accepted exactly chunk 1 (bytes 0..16MB-1) → resume at 16MB
        new Response(null, {
          status: 308,
          headers: { range: `bytes=0-${16 * MB - 1}` },
        }),
    });

    const provider = new YouTubeProvider();
    const result = await provider.publishPost(tokens, videoPayload("https://s3.example.com/big.mp4"));

    expect(result.platformPostId).toBe("yt123");
    expect(offsetQueries).toEqual([`bytes */${totalBytes}`]);
    // The retried chunk resumes at the offset Google reported (16MB), not byte 0
    expect(chunkPuts[2]!.contentRange).toBe(`bytes ${16 * MB}-${32 * MB - 1}/${totalBytes}`);
    // 6 data PUTs total: 5 chunks + 1 retried
    expect(chunkPuts).toHaveLength(6);
  }, 20_000);

  it("treats a 200 offset-query response as upload-complete — no bytes re-sent", async () => {
    const totalBytes = 80 * MB;
    const chunkPuts: ChunkPut[] = [];
    const offsetQueries: string[] = [];

    mockStreamedUpload({
      totalBytes,
      chunkPuts,
      offsetQueries,
      putHandler: (_put, i) => {
        if (i === 1) return new TypeError("fetch failed");
        return new Response(null, { status: 308 });
      },
      // Upload actually completed server-side (closes the final-chunk
      // double-publish window)
      offsetHandler: () => jsonResponse({ id: "yt-done" }),
    });

    const provider = new YouTubeProvider();
    const result = await provider.publishPost(tokens, videoPayload("https://s3.example.com/big.mp4"));

    expect(result.platformPostId).toBe("yt-done");
    // Only the 2 data PUTs that happened BEFORE the offset query — nothing re-sent after
    expect(chunkPuts).toHaveLength(2);
  }, 20_000);

  it("retries a 5xx chunk PUT status on the streamed path", async () => {
    const totalBytes = 80 * MB;
    const chunkPuts: ChunkPut[] = [];
    const offsetQueries: string[] = [];

    mockStreamedUpload({
      totalBytes,
      chunkPuts,
      offsetQueries,
      putHandler: (_put, i) => {
        if (i === 0) return new Response(null, { status: 503 });
        if (i === 5) return jsonResponse({ id: "yt503" });
        return new Response(null, { status: 308 });
      },
      offsetHandler: () => new Response(null, { status: 308 }), // no Range header → restart at 0
    });

    const provider = new YouTubeProvider();
    const result = await provider.publishPost(tokens, videoPayload("https://s3.example.com/big.mp4"));
    expect(result.platformPostId).toBe("yt503");
    expect(offsetQueries).toHaveLength(1);
    // After the 503 the offset query said nothing accepted → chunk resent from byte 0
    expect(chunkPuts[1]!.contentRange).toBe(`bytes 0-${16 * MB - 1}/${totalBytes}`);
  }, 20_000);

  it("does NOT retry a non-transient 4xx — throws immediately with the chunk error", async () => {
    const totalBytes = 80 * MB;
    const chunkPuts: ChunkPut[] = [];
    const offsetQueries: string[] = [];

    mockStreamedUpload({
      totalBytes,
      chunkPuts,
      offsetQueries,
      putHandler: () => jsonResponse({ error: "invalid" }, 403),
    });

    const provider = new YouTubeProvider();
    await expect(
      provider.publishPost(tokens, videoPayload("https://s3.example.com/big.mp4"))
    ).rejects.toThrow(/YouTube video upload failed on chunk/);
    expect(offsetQueries).toHaveLength(0);
    expect(chunkPuts).toHaveLength(1);
  });

  it("BUFFERED (≤64MB) path stays byte-identical: a failed chunk throws immediately, no offset query, single attempt", async () => {
    const totalBytes = 1 * MB; // ≤ threshold → buffered path
    const chunkPuts: ChunkPut[] = [];
    const offsetQueries: string[] = [];

    let dataPutIndex = 0;
    global.fetch = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u.startsWith("https://s3.example.com/") && init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-length": String(totalBytes), "content-type": "video/mp4" },
        });
      }
      if (u.startsWith("https://s3.example.com/")) {
        // full download (buffered path)
        return new Response(new Uint8Array(totalBytes), { status: 200 });
      }
      if (u.includes("googleapis.com/upload/youtube/v3/videos")) {
        return new Response(JSON.stringify({}), { status: 200, headers: { location: SESSION_URL } });
      }
      if (u === SESSION_URL) {
        const contentRange = String(init?.headers?.["Content-Range"] ?? "");
        if (contentRange.startsWith("bytes */")) {
          offsetQueries.push(contentRange);
          return new Response(null, { status: 308 });
        }
        chunkPuts.push({ contentRange });
        dataPutIndex++;
        throw new TypeError("fetch failed"); // transient — but buffered path must NOT retry
      }
      throw new Error(`Unexpected request: ${u}`);
    }) as any;

    const provider = new YouTubeProvider();
    await expect(
      provider.publishPost(tokens, videoPayload("https://s3.example.com/small.mp4"))
    ).rejects.toThrow(/fetch failed/);
    expect(dataPutIndex).toBe(1); // exactly one attempt
    expect(offsetQueries).toHaveLength(0); // no resumable-protocol traffic
  });
});
