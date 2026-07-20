import { describe, it, expect, vi, afterEach } from "vitest";
import { headRemoteMedia, fetchByteRange, computeByteRanges } from "../utils/ranged-media";

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockFetch(impl: (url: string, init?: any) => Promise<Response>) {
  global.fetch = vi.fn(impl) as any;
}

describe("headRemoteMedia", () => {
  it("uses HEAD content-length when available", async () => {
    mockFetch(async () =>
      new Response(null, { status: 200, headers: { "content-length": "4096", "content-type": "video/mp4" } })
    );
    await expect(headRemoteMedia("https://s3/vid.mp4")).resolves.toEqual({ size: 4096, contentType: "video/mp4" });
  });

  it("falls back to a 1-byte ranged GET and parses Content-Range", async () => {
    mockFetch(async (_url, init) => {
      if (init?.method === "HEAD") return new Response(null, { status: 405 });
      expect(init?.headers?.Range).toBe("bytes=0-0");
      return new Response(new Uint8Array([0]), {
        status: 206,
        headers: { "content-range": "bytes 0-0/123456", "content-type": "video/mp4" },
      });
    });
    await expect(headRemoteMedia("https://s3/vid.mp4")).resolves.toEqual({ size: 123456, contentType: "video/mp4" });
  });

  it("throws when no size can be determined (206 without content-range)", async () => {
    mockFetch(async () => new Response(new Uint8Array([0]), { status: 206, headers: {} }));
    await expect(headRemoteMedia("https://s3/vid.mp4")).rejects.toThrow(/did not honor the size probe/);
  });

  it("REFUSES a Range-ignoring 200 fallback WITHOUT reading the multi-GB body", async () => {
    // Never-ending body stream: reading it before validation (the reviewed
    // defect) would hang this await until the test timeout — prompt rejection
    // proves the validation happens header-first.
    mockFetch(async (_url, init) => {
      if (init?.method === "HEAD") return new Response(null, { status: 405 });
      return new Response(new ReadableStream({ pull() { /* never ends */ } }), { status: 200 });
    });
    await expect(headRemoteMedia("https://s3/vid.mp4")).rejects.toThrow(/did not honor the size probe/);
  });
});

describe("fetchByteRange", () => {
  it("returns the chunk on 206", async () => {
    mockFetch(async (_url, init) => {
      expect(init?.headers?.Range).toBe("bytes=10-19");
      return new Response(new Uint8Array(10).fill(7), { status: 206 });
    });
    const buf = await fetchByteRange("https://s3/vid.mp4", 10, 19);
    expect(buf.length).toBe(10);
  });

  it("REFUSES a 200 full-body response for a partial range WITHOUT reading the body (header-based)", async () => {
    // The mocked body is a NEVER-ENDING stream: if the guard read the body
    // before deciding (the reviewed defect), this await would hang until the
    // test timeout. Prompt rejection IS the proof of header-based refusal.
    mockFetch(async () =>
      new Response(new ReadableStream({ pull() { /* never enqueues, never closes */ } }), {
        status: 200,
        headers: { "content-length": String(4_000_000_000) },
      })
    );
    await expect(fetchByteRange("https://s3/vid.mp4", 0, 9)).rejects.toThrow(/ignored Range/);
  });

  it("REFUSES a 200 with no content-length header (cannot prove the range covers the file)", async () => {
    mockFetch(async () => new Response(new ReadableStream({ pull() {} }), { status: 200 }));
    await expect(fetchByteRange("https://s3/vid.mp4", 0, 9)).rejects.toThrow(/ignored Range/);
  });

  it("accepts a 200 only when content-length proves the range covers the whole file", async () => {
    mockFetch(async () =>
      new Response(new Uint8Array(100), { status: 200, headers: { "content-length": "100" } })
    );
    const buf = await fetchByteRange("https://s3/vid.mp4", 0, 99);
    expect(buf.length).toBe(100);
  });

  it("throws on error statuses", async () => {
    mockFetch(async () => new Response(null, { status: 404 }));
    await expect(fetchByteRange("https://s3/vid.mp4", 0, 9)).rejects.toThrow(/HTTP 404/);
  });
});

describe("computeByteRanges", () => {
  it("covers the file exactly with inclusive ranges", () => {
    expect(computeByteRanges(10, 4)).toEqual([[0, 3], [4, 7], [8, 9]]);
  });
  it("single chunk when file smaller than chunk size", () => {
    expect(computeByteRanges(3, 4)).toEqual([[0, 2]]);
  });
  it("empty for zero-size input", () => {
    expect(computeByteRanges(0, 4)).toEqual([]);
  });
});
