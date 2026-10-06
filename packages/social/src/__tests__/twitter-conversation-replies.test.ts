import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "node:crypto";
import { TwitterProvider } from "../providers/twitter.provider";

/**
 * searchConversationReplies (2026-10-06, X reply sentiment): the recent-search
 * URL, and an OAuth 1.0a signature that X will accept — recomputed here
 * independently from RFC 5849, so an encoding slip (":" / "," / "+" in the
 * query) fails this test rather than every request in production.
 */

const realFetch = global.fetch;
const orig = { id: process.env.TWITTER_CLIENT_ID, secret: process.env.TWITTER_CLIENT_SECRET };
beforeAll(() => {
  process.env.TWITTER_CLIENT_ID = "consumer-key";
  process.env.TWITTER_CLIENT_SECRET = "consumer-secret";
});
afterAll(() => {
  if (orig.id === undefined) delete process.env.TWITTER_CLIENT_ID;
  else process.env.TWITTER_CLIENT_ID = orig.id;
  if (orig.secret === undefined) delete process.env.TWITTER_CLIENT_SECRET;
  else process.env.TWITTER_CLIENT_SECRET = orig.secret;
});
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function expectedSignature(method: string, url: string, oauthParams: Record<string, string>, tokenSecret: string): string {
  const u = new URL(url);
  const params: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams) params.push([k, v]);
  for (const [k, v] of Object.entries(oauthParams)) if (k !== "oauth_signature") params.push([k, v]);
  const normalized = params
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [method, rfc3986(`${u.origin}${u.pathname}`), rfc3986(normalized)].join("&");
  return crypto.createHmac("sha1", `${rfc3986("consumer-secret")}&${rfc3986(tokenSecret)}`).update(base).digest("base64");
}

function parseOAuthHeader(h: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of h.replace(/^OAuth\s+/, "").matchAll(/(\w+)="([^"]*)"/g)) out[m[1]!] = decodeURIComponent(m[2]!);
  return out;
}

describe("TwitterProvider.searchConversationReplies", () => {
  it("asks recent search for the conversation, newer than since_id, with no author expansion — signed correctly", async () => {
    const fetchMock = vi.fn(async (_url: any, _init?: any) => new Response(JSON.stringify({ meta: { result_count: 0 } }), { status: 200 }));
    global.fetch = fetchMock as any;
    const res = await new TwitterProvider().searchConversationReplies(
      { accessToken: "user-token", refreshToken: "user-secret" },
      "1840000000000000001",
      { sinceId: "1840000000000000020", maxResults: 25 }
    );
    expect(res).toEqual({ status: 200, body: { meta: { result_count: 0 } } });

    const url = String(fetchMock.mock.calls[0]![0]);
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe("https://api.twitter.com/2/tweets/search/recent");
    expect(u.searchParams.get("query")).toBe("conversation_id:1840000000000000001");
    expect(u.searchParams.get("since_id")).toBe("1840000000000000020");
    expect(u.searchParams.get("max_results")).toBe("25");
    expect(u.searchParams.get("tweet.fields")).toBe("author_id,created_at,conversation_id,referenced_tweets");
    expect(u.searchParams.has("expansions")).toBe(false);
    expect(url).not.toContain("+");

    const header = (fetchMock.mock.calls[0]![1] as any).headers.Authorization as string;
    const oauth = parseOAuthHeader(header);
    expect(oauth.oauth_token).toBe("user-token");
    expect(oauth.oauth_consumer_key).toBe("consumer-key");
    expect(oauth.oauth_signature).toBe(expectedSignature("GET", url, oauth, "user-secret"));
  });

  it("omits since_id on the first read and clamps max_results to X's 10–100", async () => {
    const fetchMock = vi.fn(async () => new Response("not json", { status: 503 }));
    global.fetch = fetchMock as any;
    const p = new TwitterProvider();
    expect(await p.searchConversationReplies({ accessToken: "t", refreshToken: "s" }, "123456", { sinceId: null, maxResults: 3 })).toEqual({
      status: 503,
      body: null,
    });
    const u = new URL(String((fetchMock.mock.calls[0] as any)[0]));
    expect(u.searchParams.has("since_id")).toBe(false);
    expect(u.searchParams.get("max_results")).toBe("10");
  });
});
