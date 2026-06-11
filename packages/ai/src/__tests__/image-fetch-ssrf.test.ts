import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

/**
 * SSRF guard for the Super Agent's server-side image fetch (Gemini path).
 * The allowlist is built from S3 env at module load, so set it BEFORE importing.
 */
beforeAll(() => {
  process.env.S3_PUBLIC_URL = "https://media.postautomation.co.in/postautomation-media";
});

describe("__isAllowedImageUrl (SSRF guard)", () => {
  async function load() {
    const mod = await import("../chains/chat-agent.chain");
    return mod.__isAllowedImageUrl;
  }

  it("allows the configured S3 public host", async () => {
    const isAllowed = await load();
    expect(isAllowed("https://media.postautomation.co.in/postautomation-media/x.png")).toBe(true);
  });
  it("blocks an arbitrary external host (not allowlisted)", async () => {
    const isAllowed = await load();
    expect(isAllowed("https://evil.example.com/x.png")).toBe(false);
  });
  it("blocks loopback / private / link-local / metadata IPs", async () => {
    const isAllowed = await load();
    expect(isAllowed("http://127.0.0.1/x")).toBe(false);
    expect(isAllowed("http://10.0.0.5/x")).toBe(false);
    expect(isAllowed("http://192.168.1.1/x")).toBe(false);
    expect(isAllowed("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowed("http://[::1]/x")).toBe(false);
    expect(isAllowed("http://localhost/x")).toBe(false);
  });
  it("blocks non-http(s) schemes", async () => {
    const isAllowed = await load();
    expect(isAllowed("file:///etc/passwd")).toBe(false);
    expect(isAllowed("gopher://x/")).toBe(false);
  });
});

describe("isPublicPageUrl", () => {
  async function load() {
    const mod = await import("../utils/safe-fetch-url");
    return mod.isPublicPageUrl;
  }

  it("allows a public http(s) page URL", async () => {
    const isPublicPageUrl = await load();
    expect(isPublicPageUrl("https://www.instagram.com/p/abc/")).toBe(true);
  });

  it("blocks metadata / private / loopback / link-local hosts", async () => {
    const isPublicPageUrl = await load();
    expect(isPublicPageUrl("http://169.254.169.254/")).toBe(false);
    expect(isPublicPageUrl("http://10.0.0.5/page")).toBe(false);
    expect(isPublicPageUrl("http://192.168.1.1/x")).toBe(false);
    expect(isPublicPageUrl("http://127.0.0.1/x")).toBe(false);
    expect(isPublicPageUrl("http://[::1]/x")).toBe(false);
    expect(isPublicPageUrl("http://localhost/x")).toBe(false);
  });

  it("blocks non-http(s) schemes and non-URL strings", async () => {
    const isPublicPageUrl = await load();
    expect(isPublicPageUrl("ftp://example.com/x")).toBe(false);
    expect(isPublicPageUrl("file:///etc/passwd")).toBe(false);
    expect(isPublicPageUrl("not a url")).toBe(false);
  });
});

describe("safeFetchPublicImage", () => {
  async function load() {
    const mod = await import("../utils/safe-fetch-url");
    return mod.safeFetchPublicImage;
  }

  /** Build a minimal mock Response with controllable headers + body size. */
  function mockResponse(opts: {
    ok?: boolean;
    status?: number;
    contentType?: string | null;
    byteLength?: number;
  }): Response {
    const buf = new ArrayBuffer(opts.byteLength ?? 4);
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? (opts.contentType ?? null) : null,
      },
      arrayBuffer: async () => buf,
    } as unknown as Response;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when isPublicImageUrl(url) is false (metadata host)", async () => {
    const safeFetchPublicImage = await load();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await safeFetchPublicImage("http://169.254.169.254/");
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when the response content-type is text/html", async () => {
    const safeFetchPublicImage = await load();
    const fetchMock = vi.fn(async () => mockResponse({ contentType: "text/html" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await safeFetchPublicImage("https://cdn.example.com/page.html");
    expect(result).toBeNull();
  });

  it("returns null when the body exceeds maxBytes", async () => {
    const safeFetchPublicImage = await load();
    const fetchMock = vi.fn(async () =>
      mockResponse({ contentType: "image/png", byteLength: 1000 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await safeFetchPublicImage("https://cdn.example.com/big.png", {
      maxBytes: 100,
    });
    expect(result).toBeNull();
  });

  it("does not follow a 30x redirect (redirect:manual) → returns null", async () => {
    const safeFetchPublicImage = await load();
    // manual redirect → res.ok is false for a 302; treat as failure.
    const fetchMock = vi.fn(
      async (_input: unknown, _init?: RequestInit) =>
        mockResponse({ ok: false, status: 302, contentType: null }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await safeFetchPublicImage("https://cdn.example.com/redirect");
    expect(result).toBeNull();
    // Assert redirect:"manual" was passed so a 302 to a metadata host is not followed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("manual");
  });

  it("returns { base64, mimeType } for a valid image/png under the cap", async () => {
    const safeFetchPublicImage = await load();
    const fetchMock = vi.fn(async () =>
      mockResponse({ contentType: "image/png", byteLength: 4 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await safeFetchPublicImage("https://cdn.example.com/logo.png");
    expect(result).not.toBeNull();
    expect(result?.mimeType).toBe("image/png");
    // 4 zero bytes → base64 "AAAAAA=="
    expect(result?.base64).toBe(Buffer.from(new Uint8Array(4)).toString("base64"));
  });

  it("decodes a data:image/png base64 URL WITHOUT calling fetch", async () => {
    const safeFetchPublicImage = await load();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await safeFetchPublicImage("data:image/png;base64,XXXX");
    expect(result).toEqual({ base64: "XXXX", mimeType: "image/png" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a data:image/svg+xml URL (defense-in-depth, no fetch)", async () => {
    const safeFetchPublicImage = await load();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // SVG can carry script; the data: branch mime allowlist must reject it
    // even if the upstream isPublicImageUrl gate is ever loosened.
    const result = await safeFetchPublicImage("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=");
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
