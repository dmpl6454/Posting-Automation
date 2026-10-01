/**
 * Repurpose URL extraction (repurpose.extractUrl, available to every org
 * member) returns the fetched page's title/description/body to the caller.
 *
 * Reproduced in review (2026-10-01): detectUrlType matched platforms by
 * SUBSTRING, so http://instagram.com.attacker.tld/x took the Instagram path,
 * whose fetch used redirect:"follow" — the attacker answered 302 to an internal
 * address and that reply's text came back to the user. Fixed by:
 *   - exact platform host matching;
 *   - fetchPublicUrl on every request to the user's URL: redirects are
 *     followed by hand, and every hop must be public by string AND by DNS;
 *   - a resolved-address check before the first request.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const lookup = vi.fn(async (host: string, _o?: unknown) =>
  host.startsWith("internal") ? [{ address: "172.18.0.4", family: 4 }] : [{ address: "93.184.216.34", family: 4 }],
);
vi.mock("node:dns", () => {
  const promises = { lookup: (...a: any[]) => (lookup as any)(...a) };
  return { promises, default: { promises } };
});

import { extractUrlContent, resolveImageFromPageUrl, __test__ } from "../utils/url-extractor";
import { fetchPublicUrl, hostResolvesPublic } from "../utils/safe-fetch-url";

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
function stubFetch(handler: (url: string) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: unknown, init: RequestInit = {}) => {
      const url = String(u);
      calls.push({ url, init });
      return handler(url);
    }),
  );
}
const html = (title: string) =>
  new Response(`<html><head><title>${title}</title><meta property="og:title" content="${title}"></head><body>${title} body text that is long enough to count as content for the extractor</body></html>`, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

beforeEach(() => {
  calls = [];
  lookup.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("detectUrlType matches platform hosts exactly", () => {
  it.each([
    ["https://www.instagram.com/p/x", "instagram"],
    ["https://instagram.com.attacker.tld/x", "article"],
    ["https://x.com/a/status/1", "twitter"],
    ["https://netflix.com/title/1", "article"], // contains "x.com"
    ["https://m.facebook.com/story.php", "facebook"],
    ["https://myfacebook.com/p", "article"],
    ["https://youtu.be/abc", "youtube"],
    ["https://evil-youtube.com/watch", "article"],
    ["https://www.linkedin.com/posts/x", "linkedin"],
    ["https://linkedin.com.evil.tld/x", "article"],
  ])("%s → %s", (url, type) => {
    expect(__test__.detectUrlType(url)).toBe(type);
  });
});

describe("fetchPublicUrl", () => {
  it("refuses a name that resolves to a private address, before any request", async () => {
    stubFetch(() => html("x"));
    await expect(fetchPublicUrl("https://internal.example.com/")).rejects.toThrow(/public internet/);
    expect(calls).toHaveLength(0);
  });

  it.each(["http://127.0.0.1:9000/secret", "http://minio:9000/postautomation-media/", "http://internal.example.com/x", "http://[::ffff:a9fe:a9fe]/"])(
    "never follows a redirect to %s",
    async (location) => {
      stubFetch((url) => (url.startsWith("https://site.example") ? new Response(null, { status: 302, headers: { location } }) : html("INTERNAL")));
      await expect(fetchPublicUrl("https://site.example.com/a")).rejects.toThrow(/public internet/);
      expect(calls.map((c) => c.url)).toEqual(["https://site.example.com/a"]);
    },
  );

  it("follows public redirects by hand (relative ones too), each hop with redirect: manual", async () => {
    stubFetch((url) =>
      url === "https://a.example.com/1"
        ? new Response(null, { status: 301, headers: { location: "https://b.example.com/2" } })
        : url === "https://b.example.com/2"
          ? new Response(null, { status: 302, headers: { location: "/3" } })
          : html("final"),
    );
    const res = await fetchPublicUrl("https://a.example.com/1");
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(["https://a.example.com/1", "https://b.example.com/2", "https://b.example.com/3"]);
    for (const c of calls) expect(c.init.redirect).toBe("manual");
  });

  it("stops after maxHops and hands back the redirect, unfollowed", async () => {
    stubFetch(() => new Response(null, { status: 302, headers: { location: "https://loop.example.com/" } }));
    const res = await fetchPublicUrl("https://loop.example.com/", {}, 2);
    expect(res.status).toBe(302);
    expect(calls).toHaveLength(3);
  });
});

describe("hostResolvesPublic", () => {
  it("judges IP literals without DNS and names by every resolved address", async () => {
    expect(await hostResolvesPublic("[::ffff:7f00:1]")).toBe(false);
    expect(await hostResolvesPublic("93.184.216.34")).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
    expect(await hostResolvesPublic("internal.example.com")).toBe(false);
    expect(await hostResolvesPublic("news.example.com")).toBe(true);
  });
});

describe("extractUrlContent", () => {
  it("refuses a URL whose name resolves to a private address, before any request", async () => {
    stubFetch(() => html("x"));
    await expect(extractUrlContent("https://internal.example.com/article")).rejects.toThrow(/not accessible/);
    expect(calls).toHaveLength(0);
  });

  it.each([
    "https://www.instagram.com/p/abc/",
    "https://x.com/someone/status/123",
    "https://www.facebook.com/someone/posts/1",
    "https://www.linkedin.com/posts/someone_activity-1",
    "https://www.youtube.com/watch?v=abcdefghijk",
  ])("every request to the user's own URL for %s is made with redirect: manual", async (url) => {
    const mobile = url.replace("www.facebook.com", "m.facebook.com");
    // Third-party helpers (oEmbed, fxtwitter, ddinstagram, reader proxy) answer
    // 404 so each extractor falls through to fetching the user's URL itself.
    stubFetch((u) => (u === url || u === mobile ? html("A real post") : new Response("nope", { status: 404 })));
    await extractUrlContent(url).catch(() => undefined);
    const own = calls.filter((c) => c.url === url || c.url === mobile);
    expect(own.length).toBeGreaterThan(0);
    for (const c of own) expect(c.init.redirect, c.url).toBe("manual");
  });
});

describe("resolveImageFromPageUrl", () => {
  it("returns null for a name that resolves to a private address, without a request", async () => {
    stubFetch(() => html("x"));
    expect(await resolveImageFromPageUrl("https://internal.example.com/p")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
