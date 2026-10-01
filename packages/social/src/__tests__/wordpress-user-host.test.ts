/**
 * WordPressProvider's SELF-HOSTED path contacts the site the USER named only
 * through userHostFetch (2026-10-01 publish-time SSRF fix). The WordPress.com
 * OAuth path talks to a fixed host and is unchanged.
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

import { WordPressProvider } from "../providers/wordpress.provider";
import { UserHostError } from "../utils/user-host-fetch";
import { isAmbiguousPublishError } from "../utils/ambiguous-publish";
import { isPublishRefusedError } from "../utils/publish-refused";

const SITE = "https://blog.example.com";
const selfHosted = { accessToken: "YWRtaW46cHc=", metadata: { kind: "self-hosted", siteUrl: SITE } } as any;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const p = new WordPressProvider();

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

describe("WordPressProvider self-hosted publishPost", () => {
  it("creates the post on the channel's site through userHostFetch", async () => {
    userHostFetch.mockResolvedValueOnce(json(201, { id: 42, link: `${SITE}/hello`, slug: "hello", status: "publish" }));
    const r = await p.publishPost(selfHosted, { content: "Hello\nworld" } as any);
    expect(r).toMatchObject({ platformPostId: "42", url: `${SITE}/hello` });
    const [url, init] = userHostFetch.mock.calls[0]!;
    expect(url).toBe(`${SITE}/wp-json/wp/v2/posts`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Basic YWRtaW46cHc=");
    expect(JSON.parse(init.body)).toEqual({ title: "Hello", content: "Hello\nworld", status: "publish" });
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("uploads the featured image first, with a safe filename", async () => {
    userHostFetch.mockResolvedValueOnce(json(201, { id: 9 })).mockResolvedValueOnce(json(201, { id: 42, link: "l" }));
    await p.publishPost(selfHosted, { content: "x", mediaUrls: ['https://postautomation.co.in/media/a"b\r\nc.png?v=1'] } as any);
    expect(globalFetch).toHaveBeenCalledTimes(1); // the file comes from our storage
    const [mediaUrl, mediaInit] = userHostFetch.mock.calls[0]!;
    expect(mediaUrl).toBe(`${SITE}/wp-json/wp/v2/media`);
    expect(mediaInit.headers["Content-Disposition"]).toBe('attachment; filename="a_b__c.png"');
    expect(JSON.parse(userHostFetch.mock.calls[1]![1].body).featured_media).toBe(9);
  });

  it("a create that reached the site and then failed is unconfirmed", async () => {
    userHostFetch.mockRejectedValueOnce(new UserHostError("transport", { code: "ECONNRESET", requestSent: true }));
    const e = await caught(p.publishPost(selfHosted, { content: "x" } as any));
    expect(isAmbiguousPublishError(e)).toBe(true);
    expect(e.message).toMatch(/Posts \(including Drafts\)/);
  });

  it("a 201 without a readable id is unconfirmed — the post was created", async () => {
    userHostFetch.mockResolvedValueOnce(new Response("not json", { status: 201 }));
    expect(isAmbiguousPublishError(await caught(p.publishPost(selfHosted, { content: "x" } as any)))).toBe(true);
  });

  it("a rejected application password is refused with the fix, not retried", async () => {
    userHostFetch.mockResolvedValueOnce(json(401, { code: "rest_cannot_create", message: "Sorry, you are not allowed" }));
    const e = await caught(p.publishPost(selfHosted, { content: "x" } as any));
    expect(isPublishRefusedError(e)).toBe(true);
    expect(e.message).toMatch(/Application Password/);
  });

  it("is chosen by the CHANNEL's metadata; a client-supplied blog_id cannot redirect it to WordPress.com", async () => {
    userHostFetch.mockResolvedValueOnce(json(201, { id: 1, link: "l" }));
    await p.publishPost(selfHosted, { content: "x", metadata: { blog_id: "123" } } as any);
    expect(userHostFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe("WordPressProvider self-hosted deletePost", () => {
  it("deletes through userHostFetch and never echoes the body", async () => {
    userHostFetch.mockResolvedValueOnce(json(500, { secret: "internal-data" }));
    const e = await caught(p.deletePost(selfHosted, "42"));
    expect(userHostFetch.mock.calls[0]![0]).toBe(`${SITE}/wp-json/wp/v2/posts/42?force=true`);
    expect(e.message).not.toMatch(/internal-data/);
  });
});

describe("WordPress.com (OAuth) path is unchanged", () => {
  it("still posts to public-api.wordpress.com with plain fetch", async () => {
    globalFetch.mockResolvedValueOnce(json(200, { ID: 5, URL: "https://x.wordpress.com/p" }));
    await p.publishPost({ accessToken: "bearer", metadata: { blog_id: "77" } } as any, { content: "x" } as any);
    expect(globalFetch.mock.calls[0]![0]).toBe("https://public-api.wordpress.com/rest/v1.2/sites/77/posts/new");
    expect(userHostFetch).not.toHaveBeenCalled();
  });
});

describe("source lock", () => {
  it("never calls plain fetch() on the user's site — only on WordPress.com and our own media files", () => {
    const src = readFileSync(join(__dirname, "../providers/wordpress.provider.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const calls = src.match(/(?<![\w.])fetch\(\s*[^,)]*/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c, c).toMatch(/fetch\(\s*(`https:\/\/public-api\.wordpress\.com|"https:\/\/public-api\.wordpress\.com|mediaUrl$)/);
    }
    expect(src).not.toMatch(/fetch\(`\$\{siteUrl\}/);
  });
});
