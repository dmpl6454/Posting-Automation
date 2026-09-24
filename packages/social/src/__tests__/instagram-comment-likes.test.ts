import { describe, it, expect, vi, afterEach } from "vitest";
import { InstagramProvider } from "../providers/instagram.provider";
import {
  COMMENT_ACTION_FAILED_MESSAGE,
  COMMENT_LIKE_PERMISSION_MESSAGE,
  COMMENT_LIKE_TARGET_GONE_MESSAGE,
  COMMENT_LIKE_THROTTLED_MESSAGE,
  COMMENT_TOKEN_INVALID_MESSAGE,
  isInstagramLikeRefusedError,
  isCommentObjectGoneError,
} from "../utils/instagram-comments";
import { COMMENT_ACTION_UNCONFIRMED_MESSAGE } from "../utils/social-comments";

/**
 * Instagram likes (2026-09-23) — `POST|DELETE /{ig-user-id}/likes` with
 * `comment_id` or `media_id` (User Likes reference; Graph changelog
 * 2026-04-22, "applies to all versions"). Mocked Graph.
 */

type Reply = { ok: boolean; status?: number; body?: any; unparseable?: boolean; throws?: Error };
interface Call { url: string; method: string; body?: any }

function mockGraph(handler: (url: string, method: string) => Reply) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? "GET").toUpperCase();
      let body: any;
      try {
        body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      } catch {
        body = init?.body;
      }
      calls.push({ url: String(url), method, body });
      const r = handler(String(url), method);
      if (r.throws) throw r.throws;
      const res: any = {
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 400),
        json: async () => {
          if (r.unparseable) throw new SyntaxError("Unexpected token '<'");
          return r.body;
        },
        headers: { get: () => null },
      };
      res.clone = () => res;
      return res;
    })
  );
  return calls;
}

const tokens = { accessToken: "USER_TOKEN" };
const IG_USER = "17841427778726243";

/** VERBATIM from prod 2026-09-23: DELETE /{ig-user}/likes with a token lacking the permission. */
const MEASURED_REFUSAL = { error: { code: 100, error_subcode: 33, type: "GraphMethodException", message: "Authorization Error" } };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("InstagramProvider likes — request shape", () => {
  it("like a comment = POST /{ig-user-id}/likes with comment_id; the token rides in the BODY", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { success: true } }));
    await new InstagramProvider().setCommentLiked(tokens, IG_USER, "17900000000000001", true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(new URL(calls[0]!.url).pathname).toBe(`/v18.0/${IG_USER}/likes`);
    expect(calls[0]!.body).toEqual({ comment_id: "17900000000000001", access_token: "USER_TOKEN" });
    expect(new URL(calls[0]!.url).searchParams.get("access_token")).toBeNull();
  });

  it("unlike a comment = DELETE on the same edge with comment_id in the query", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { success: true } }));
    await new InstagramProvider().setCommentLiked(tokens, IG_USER, "17900000000000001", false);
    const u = new URL(calls[0]!.url);
    expect(calls[0]!.method).toBe("DELETE");
    expect(u.pathname).toBe(`/v18.0/${IG_USER}/likes`);
    expect(u.searchParams.get("comment_id")).toBe("17900000000000001");
    expect(u.searchParams.get("media_id")).toBeNull();
  });

  it("like / unlike the POST = the same edge with media_id (never both ids)", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { success: true } }));
    await new InstagramProvider().setMediaLiked(tokens, IG_USER, "18000000000000009", true);
    await new InstagramProvider().setMediaLiked(tokens, IG_USER, "18000000000000009", false);
    expect(calls[0]!.body).toEqual({ media_id: "18000000000000009", access_token: "USER_TOKEN" });
    expect(new URL(calls[1]!.url).searchParams.get("media_id")).toBe("18000000000000009");
    expect(new URL(calls[1]!.url).searchParams.get("comment_id")).toBeNull();
  });

  it("🔴 encodes the ig user id so a crafted value cannot retarget the call", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { success: true } }));
    await new InstagramProvider().setCommentLiked(tokens, `${IG_USER}/media?x=`, "1", true);
    expect(new URL(calls[0]!.url).pathname).not.toContain("/media");
    expect(new URL(calls[0]!.url).pathname.endsWith("/likes")).toBe(true);
  });
});

describe("InstagramProvider likes — outcomes", () => {
  it("🔴 the MEASURED refusal (#100/33 'Authorization Error') means a missing permission, NOT a deleted comment", async () => {
    expect(isInstagramLikeRefusedError(MEASURED_REFUSAL.error)).toBe(true);
    // The generic classifier WOULD read it as object-gone — which is why order matters.
    expect(isCommentObjectGoneError(MEASURED_REFUSAL.error)).toBe(true);
    mockGraph(() => ({ ok: false, status: 400, body: MEASURED_REFUSAL }));
    await expect(new InstagramProvider().setCommentLiked(tokens, IG_USER, "1", true)).rejects.toThrow(COMMENT_LIKE_PERMISSION_MESSAGE);
    await expect(new InstagramProvider().setMediaLiked(tokens, IG_USER, "2", false)).rejects.toThrow(COMMENT_LIKE_PERMISSION_MESSAGE);
  });

  it("the standard #100/33 'does not exist' text is a gone target", async () => {
    mockGraph(() => ({
      ok: false,
      body: { error: { code: 100, error_subcode: 33, message: "Unsupported post request. Object with ID '1' does not exist, cannot be loaded due to missing permissions, or does not support this operation." } },
    }));
    await expect(new InstagramProvider().setCommentLiked(tokens, IG_USER, "1", true)).rejects.toThrow(COMMENT_LIKE_TARGET_GONE_MESSAGE);
  });

  it("maps the other permission shapes, a dead token, and throttles", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const error of [
      { code: 10, message: "(#10) Application does not have permission for this action" },
      { code: 200, message: "(#200) Permissions error" },
      { code: 100, message: "(#100) Missing Permission" },
    ]) {
      mockGraph(() => ({ ok: false, body: { error } }));
      await expect(new InstagramProvider().setCommentLiked(tokens, IG_USER, "1", true)).rejects.toThrow(COMMENT_LIKE_PERMISSION_MESSAGE);
    }
    mockGraph(() => ({ ok: false, body: { error: { code: 190, message: "Error validating access token" } } }));
    await expect(new InstagramProvider().setCommentLiked(tokens, IG_USER, "1", true)).rejects.toThrow(COMMENT_TOKEN_INVALID_MESSAGE);
    for (const code of [4, 17, 32, 613]) {
      mockGraph(() => ({ ok: false, body: { error: { code, message: "limit reached" } } }));
      await expect(new InstagramProvider().setCommentLiked(tokens, IG_USER, "1", true)).rejects.toThrow(COMMENT_LIKE_THROTTLED_MESSAGE);
    }
  });

  it("an unknown outcome (5xx, transient, dropped request) says 'refresh', never auto-retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const r of [
      { ok: false, status: 502, unparseable: true },
      { ok: false, status: 400, body: { error: { code: 2, is_transient: true, message: "Service temporarily unavailable" } } },
      { ok: false, throws: new Error("socket hang up") },
    ] as Reply[]) {
      const calls = mockGraph(() => r);
      await expect(new InstagramProvider().setCommentLiked(tokens, IG_USER, "1", true)).rejects.toThrow(COMMENT_ACTION_UNCONFIRMED_MESSAGE);
      expect(calls).toHaveLength(1);
    }
  });

  it("an explicit success:false and an unrecognised error are plain failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGraph(() => ({ ok: true, body: { success: false } }));
    await expect(new InstagramProvider().setCommentLiked(tokens, IG_USER, "1", true)).rejects.toThrow(COMMENT_ACTION_FAILED_MESSAGE);
    mockGraph(() => ({ ok: false, body: { error: { code: 1, message: "An unknown error occurred" } } }));
    await expect(new InstagramProvider().setCommentLiked(tokens, IG_USER, "1", true)).rejects.toThrow(COMMENT_ACTION_FAILED_MESSAGE);
  });
});

describe("InstagramProvider.readLikeCount", () => {
  it("reads like_count (the like/unlike response says nothing about the count)", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { like_count: 12, id: "1" } }));
    expect(await new InstagramProvider().readLikeCount(tokens, "17900000000000001")).toBe(12);
    expect(new URL(calls[0]!.url).searchParams.get("fields")).toBe("like_count");
    expect(calls[0]!.method).toBe("GET");
  });

  it("never throws — returns null on an error, a garbage value, or a dropped request", async () => {
    mockGraph(() => ({ ok: false, body: { error: { code: 100, message: "x" } } }));
    expect(await new InstagramProvider().readLikeCount(tokens, "1")).toBeNull();
    mockGraph(() => ({ ok: true, body: { like_count: "lots" } }));
    expect(await new InstagramProvider().readLikeCount(tokens, "1")).toBeNull();
    mockGraph(() => ({ ok: false, throws: new Error("timeout") }));
    expect(await new InstagramProvider().readLikeCount(tokens, "1")).toBeNull();
  });

  it("encodes the object id", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { like_count: 1 } }));
    await new InstagramProvider().readLikeCount(tokens, "1/likes?x=");
    expect(new URL(calls[0]!.url).pathname).not.toContain("/likes");
  });
});
