/**
 * MastodonProvider contacts the instance the USER named only through
 * userHostFetch (2026-10-01 publish-time SSRF fix), and reports outcomes the
 * way the duplicate-post rules require. The network call is mocked here; the
 * client itself is tested in user-host-fetch.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const userHostFetch = vi.fn(async (..._a: any[]): Promise<Response> => new Response("{}"));
vi.mock("../utils/user-host-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/user-host-fetch")>();
  return { ...actual, userHostFetch: (...a: any[]) => userHostFetch(...a) };
});

const globalFetch = vi.fn(async (..._a: any[]): Promise<Response> => new Response("IMG", { headers: { "content-type": "image/png" } }));
vi.stubGlobal("fetch", (...a: any[]) => globalFetch(...a));

import { MastodonProvider } from "../providers/mastodon.provider";
import { UserHostError } from "../utils/user-host-fetch";
import { isAmbiguousPublishError } from "../utils/ambiguous-publish";
import { isPublishRefusedError } from "../utils/publish-refused";

const INSTANCE = "https://hachyderm.io";
const tokens = { accessToken: "tok", metadata: { instance: INSTANCE } } as any;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const p = new MastodonProvider();

beforeEach(() => {
  userHostFetch.mockReset();
  globalFetch.mockClear();
});

async function caught(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("MastodonProvider.publishPost", () => {
  it("posts to the channel's own instance through userHostFetch, with an Idempotency-Key", async () => {
    userHostFetch.mockResolvedValueOnce(json(200, { id: "109", url: `${INSTANCE}/@me/109`, created_at: "x", visibility: "public" }));
    const r = await p.publishPost(tokens, { content: "hello", idempotencyKey: "pa-t1-abc" } as any);
    expect(r).toMatchObject({ platformPostId: "109", url: `${INSTANCE}/@me/109` });
    const [url, init] = userHostFetch.mock.calls[0]!;
    expect(url).toBe(`${INSTANCE}/api/v1/statuses`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.headers["Idempotency-Key"]).toBe("pa-t1-abc");
    expect(JSON.parse(init.body)).toEqual({ status: "hello" });
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("sends no Idempotency-Key when the worker gave none", async () => {
    userHostFetch.mockResolvedValueOnce(json(200, { id: "1" }));
    await p.publishPost(tokens, { content: "x" } as any);
    expect(userHostFetch.mock.calls[0]![1].headers["Idempotency-Key"]).toBeUndefined();
  });

  it("a create that reached the instance and then failed is unconfirmed", async () => {
    userHostFetch.mockRejectedValueOnce(new UserHostError("transport", { code: "ETIMEDOUT", requestSent: true }));
    expect(isAmbiguousPublishError(await caught(p.publishPost(tokens, { content: "x" } as any)))).toBe(true);
  });

  it("a 2xx without a readable id is unconfirmed — the post may exist", async () => {
    userHostFetch.mockResolvedValueOnce(new Response("<html>ok</html>", { status: 200 }));
    expect(isAmbiguousPublishError(await caught(p.publishPost(tokens, { content: "x" } as any)))).toBe(true);
  });

  it("a private instance address is refused and nothing else is attempted", async () => {
    userHostFetch.mockRejectedValueOnce(new UserHostError("blocked"));
    const e = await caught(p.publishPost(tokens, { content: "x" } as any));
    expect(isPublishRefusedError(e)).toBe(true);
    expect(e.message).not.toMatch(/hachyderm/);
  });

  it("uploads media first (polling a 202 until processed), then attaches it", async () => {
    userHostFetch
      .mockResolvedValueOnce(json(202, { id: "m1", url: null }))
      .mockResolvedValueOnce(json(206, { id: "m1", url: null }))
      .mockResolvedValueOnce(json(200, { id: "m1", url: "https://files/x.png" }))
      .mockResolvedValueOnce(json(200, { id: "s1" }));
    vi.useFakeTimers();
    try {
      const pending = p.publishPost(tokens, { content: "x", mediaUrls: ["https://postautomation.co.in/media/a.png"] } as any);
      await vi.runAllTimersAsync();
      await pending;
    } finally {
      vi.useRealTimers();
    }
    expect(globalFetch).toHaveBeenCalledTimes(1); // our own storage, not the instance
    const urls = userHostFetch.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      `${INSTANCE}/api/v2/media`,
      `${INSTANCE}/api/v1/media/m1`,
      `${INSTANCE}/api/v1/media/m1`,
      `${INSTANCE}/api/v1/statuses`,
    ]);
    expect(userHostFetch.mock.calls[0]![1].body).toBeInstanceOf(FormData);
    expect(JSON.parse(userHostFetch.mock.calls[3]![1].body)).toEqual({ status: "x", media_ids: ["m1"] });
  });

  it("a media file that cannot be downloaded fails retryably, before anything reaches the instance", async () => {
    globalFetch.mockResolvedValueOnce(new Response("nope", { status: 403 }));
    const e = await caught(p.publishPost(tokens, { content: "x", mediaUrls: ["https://postautomation.co.in/media/gone.png"] } as any));
    expect(isAmbiguousPublishError(e)).toBe(false);
    expect(isPublishRefusedError(e)).toBe(false);
    expect(e.message).not.toMatch(/403/); // the worker's classifier reads "403" as a permission error
    expect(userHostFetch).not.toHaveBeenCalled();
  });
});

describe("MastodonProvider.getProfile (used by avatar refresh)", () => {
  it("reads verify_credentials through userHostFetch", async () => {
    userHostFetch.mockResolvedValueOnce(json(200, { id: "7", display_name: "Me", acct: "me", avatar: "https://a/x.png" }));
    expect(await p.getProfile(tokens)).toEqual({ id: "7", name: "Me", username: "me", avatar: "https://a/x.png" });
    expect(userHostFetch.mock.calls[0]![0]).toBe(`${INSTANCE}/api/v1/accounts/verify_credentials`);
  });

  it("never echoes the response body", async () => {
    userHostFetch.mockResolvedValueOnce(json(500, { secret: "internal-data" }));
    expect((await caught(p.getProfile(tokens))).message).not.toMatch(/internal-data/);
  });
});

describe("MastodonProvider delete and token calls", () => {
  const config = { clientId: "id", clientSecret: "sec", callbackUrl: "https://app/cb", scopes: [], metadata: { instance: INSTANCE } } as any;

  it("deletePost goes through userHostFetch", async () => {
    userHostFetch.mockResolvedValueOnce(json(200, {}));
    await p.deletePost(tokens, "109");
    expect(userHostFetch.mock.calls[0]![0]).toBe(`${INSTANCE}/api/v1/statuses/109`);
    expect(userHostFetch.mock.calls[0]![1].method).toBe("DELETE");
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("token exchange and refresh go through userHostFetch", async () => {
    userHostFetch.mockResolvedValueOnce(json(200, { access_token: "a" })).mockResolvedValueOnce(json(200, { access_token: "b" }));
    expect((await p.exchangeCodeForTokens("code", config)).accessToken).toBe("a");
    expect((await p.refreshAccessToken("r", config)).accessToken).toBe("b");
    expect(userHostFetch.mock.calls.map((c) => c[0])).toEqual([`${INSTANCE}/oauth/token`, `${INSTANCE}/oauth/token`]);
    expect(userHostFetch.mock.calls[0]![1].body).toBeInstanceOf(URLSearchParams);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe("source lock", () => {
  it("never calls fetch() — qualified or not — on anything but the post's own media files", () => {
    const src = readFileSync(join(__dirname, "../providers/mastodon.provider.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // `(?<!\w)` (not `[\w.]`) so globalThis.fetch( and self.fetch( are counted too.
    const calls = src.match(/(?<!\w)fetch\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(src).toMatch(/(?<!\w)fetch\(mediaUrl,/);
    expect(src).not.toMatch(/fetch\(\s*`\$\{instance\}/);
  });
});
