import { describe, it, expect, vi, afterEach } from "vitest";
import { TikTokProvider, TIKTOK_PUBLISH_SCOPE_MISSING } from "../providers/tiktok.provider";

/**
 * TikTok CONNECT path (2026-10-28): token exchange, refresh, profile.
 *
 * The bug these lock: TikTok's v2 SUCCESS body carries `"error":{"code":"ok"}`.
 * The old provider read any truthy `error.code` as a failure, so every connect
 * ended in "Sign-in failed". Success is HTTP 2xx AND (no error OR code "ok").
 *
 * And: a TikTok error body is never forwarded. Its `log_id` is a digit run
 * that can contain "401"/"403", which the worker's classifier substring-matches.
 */

const LOG_ID = "20261028401403999TOKENINVALID";
const HOSTILE = "token invalid 401 403 permission rate limit too many too large fetch failed ETIMEDOUT";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  hasSignal: boolean;
}

function mockFetch(handler: (url: string, method: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).forEach((v, k) => (headers[k] = v));
      calls.push({
        url,
        method,
        headers,
        body: typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : undefined,
        hasSignal: !!init?.signal,
      });
      return handler(url, method);
    })
  );
  return calls;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (data: unknown) => json(200, { data, error: { code: "ok", message: "", log_id: LOG_ID } });
const fail = (status: number, code: string) => json(status, { data: {}, error: { code, message: HOSTILE, log_id: LOG_ID } });

const config = { clientId: "ck", clientSecret: "cs", callbackUrl: "https://app.example/cb", scopes: ["user.info.basic", "video.publish"] };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function expectClean(err: unknown) {
  const msg = (err as Error).message;
  expect(msg).not.toContain(LOG_ID);
  expect(msg).not.toContain(HOSTILE);
  expect(msg).not.toContain("error_description");
  expect(msg).not.toContain("act.");
}

describe("exchangeCodeForTokens", () => {
  it("returns the tokens on success", async () => {
    const calls = mockFetch(() =>
      json(200, {
        access_token: "act.aaa",
        refresh_token: "rft.bbb",
        expires_in: 86400,
        refresh_expires_in: 31536000,
        open_id: "open-1",
        scope: "user.info.basic,video.publish",
        token_type: "Bearer",
      })
    );
    const t = await new TikTokProvider().exchangeCodeForTokens("code-1", config);
    expect(t.accessToken).toBe("act.aaa");
    expect(t.refreshToken).toBe("rft.bbb");
    expect(t.scopes).toEqual(["user.info.basic", "video.publish"]);
    expect(t.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 86000 * 1000);
    expect(calls[0]!.hasSignal).toBe(true);
    expect(calls[0]!.body).toContain("grant_type=authorization_code");
    // The refresh token's 365-day deadline is kept for a later "reconnect soon" warning.
    expect(Date.parse(t.metadata!.refreshExpiresAt as string)).toBeGreaterThan(Date.now() + 364 * 86400 * 1000);
  });

  it("refuses a connect where the user unticked the posting permission (2026-10-28)", async () => {
    mockFetch(() => json(200, { access_token: "act.aaa", refresh_token: "rft.bbb", expires_in: 86400, scope: "user.info.basic" }));
    await expect(new TikTokProvider().exchangeCodeForTokens("c", config)).rejects.toThrow(TIKTOK_PUBLISH_SCOPE_MISSING);
  });

  it("an error body throws a fixed message without the body", async () => {
    mockFetch(() => json(400, { error: "invalid_grant", error_description: `Authorization code is expired. ${HOSTILE}`, log_id: LOG_ID }));
    const err = await new TikTokProvider().exchangeCodeForTokens("c", config).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("invalid_grant");
    expectClean(err);
  });

  it("a 200 without an access token is a failure, not a token", async () => {
    mockFetch(() => json(200, { error: { code: "ok" } }));
    await expect(new TikTokProvider().exchangeCodeForTokens("c", config)).rejects.toThrow(/TikTok/);
  });

  it("an HTML 502 does not throw a SyntaxError out of the provider", async () => {
    mockFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    const err = await new TikTokProvider().exchangeCodeForTokens("c", config).catch((e) => e);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect(err.message).not.toContain("<html>");
  });
});

describe("refreshAccessToken", () => {
  it("returns the ROTATED refresh token", async () => {
    const calls = mockFetch(() => json(200, { access_token: "act.new", refresh_token: "rft.new", expires_in: 86400, scope: "video.publish" }));
    const t = await new TikTokProvider().refreshAccessToken("rft.old", config);
    expect(t.accessToken).toBe("act.new");
    expect(t.refreshToken).toBe("rft.new");
    expect(calls[0]!.body).toContain("grant_type=refresh_token");
    expect(calls[0]!.body).toContain("refresh_token=rft.old");
    expect(calls[0]!.hasSignal).toBe(true);
  });

  it("invalid_grant is NAMED in the message (the worker reads it as a dead credential) — and nothing else from the body", async () => {
    mockFetch(() => json(400, { error: "invalid_grant", error_description: `Refresh token is invalid or expired. ${HOSTILE}`, log_id: LOG_ID }));
    const err = await new TikTokProvider().refreshAccessToken("rft", config).catch((e) => e);
    expect(err.message).toMatch(/invalid_grant/);
    expectClean(err);
  });

  it("invalid_grant in the nested v2 error shape is also named", async () => {
    mockFetch(() => fail(400, "invalid_grant"));
    const err = await new TikTokProvider().refreshAccessToken("rft", config).catch((e) => e);
    expect(err.message).toMatch(/invalid_grant/);
    expectClean(err);
  });

  it("a server error is NOT reported as invalid_grant", async () => {
    mockFetch(() => new Response(`<html>${HOSTILE} invalid_grant</html>`, { status: 503 }));
    const err = await new TikTokProvider().refreshAccessToken("rft", config).catch((e) => e);
    expect(err.message).not.toMatch(/invalid_grant/);
    expectClean(err);
  });

  it("a transport failure is NOT reported as invalid_grant", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const err = await new TikTokProvider().refreshAccessToken("rft", config).catch((e) => e);
    expect(err.message).not.toMatch(/invalid_grant/);
  });
});

describe("getProfile", () => {
  const creator = {
    creator_avatar_url: "https://p16.tiktokcdn.com/creator.jpg",
    creator_username: "creator.one",
    creator_nickname: "Creator One",
    privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
    comment_disabled: false,
    duet_disabled: false,
    stitch_disabled: false,
    max_video_post_duration_sec: 600,
  };
  const user = { open_id: "open-123", union_id: "u-1", display_name: "Creator Display", avatar_url: "https://p16.tiktokcdn.com/user.jpg" };

  it("reads the real @handle from creator_info and the open_id from user/info (success body has error.code ok)", async () => {
    const calls = mockFetch((url) => {
      if (url.includes("/creator_info/query/")) return ok(creator);
      if (url.includes("/user/info/")) return ok({ user });
      return json(404, {});
    });
    const p = await new TikTokProvider().getProfile({ accessToken: "act.x" });
    expect(p).toEqual({ id: "open-123", name: "Creator One", username: "creator.one", avatar: "https://p16.tiktokcdn.com/creator.jpg" });
    const ci = calls.find((c) => c.url.includes("/creator_info/query/"))!;
    expect(ci.method).toBe("POST");
    expect(ci.headers.authorization).toBe("Bearer act.x");
    const ui = calls.find((c) => c.url.includes("/user/info/"))!;
    expect(ui.method).toBe("GET");
    expect(ui.url).toContain("fields=open_id,union_id,avatar_url,display_name");
    expect(calls.every((c) => c.hasSignal)).toBe(true);
  });

  it("falls back to display_name only when creator_info fails", async () => {
    mockFetch((url) => (url.includes("/creator_info/") ? fail(401, "scope_not_authorized") : ok({ user })));
    const p = await new TikTokProvider().getProfile({ accessToken: "act.x" });
    expect(p).toEqual({ id: "open-123", name: "Creator Display", username: "Creator Display", avatar: "https://p16.tiktokcdn.com/user.jpg" });
  });

  it("does not show a display name as a handle when creator_info answered without one", async () => {
    mockFetch((url) => (url.includes("/creator_info/") ? ok({ ...creator, creator_username: "" }) : ok({ user })));
    const p = await new TikTokProvider().getProfile({ accessToken: "act.x" });
    expect(p.username).toBeUndefined();
    expect(p.name).toBe("Creator One");
  });

  it("throws (never an empty id) when user/info fails", async () => {
    mockFetch((url) => (url.includes("/creator_info/") ? ok(creator) : fail(401, "access_token_invalid")));
    const err = await new TikTokProvider().getProfile({ accessToken: "act.x" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expectClean(err);
  });

  it("throws when user/info succeeds without an open_id", async () => {
    mockFetch((url) => (url.includes("/creator_info/") ? ok(creator) : ok({ user: { ...user, open_id: "" } })));
    await expect(new TikTokProvider().getProfile({ accessToken: "act.x" })).rejects.toThrow();
  });

  it("an HTML 502 from user/info is a clean error, not a SyntaxError", async () => {
    mockFetch((url) => (url.includes("/creator_info/") ? ok(creator) : new Response("<html>bad gateway</html>", { status: 502 })));
    const err = await new TikTokProvider().getProfile({ accessToken: "act.x" }).catch((e) => e);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect(err.message).not.toContain("<html>");
  });
});

describe("getOAuthUrl", () => {
  it("always shows TikTok's consent page, so adding a second account is possible (2026-10-28)", () => {
    const url = new URL(new TikTokProvider().getOAuthUrl(config as any, "st"));
    expect(url.searchParams.get("disable_auto_auth")).toBe("1");
    expect(url.searchParams.get("scope")).toBe("user.info.basic,video.publish");
  });
});
