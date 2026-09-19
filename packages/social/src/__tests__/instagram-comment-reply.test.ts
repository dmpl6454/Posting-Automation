import { describe, it, expect, vi, afterEach } from "vitest";
import { InstagramProvider } from "../providers/instagram.provider";
import {
  COMMENT_PERMISSION_DENIED_MESSAGE,
  COMMENT_OBJECT_GONE_MESSAGE,
} from "../utils/instagram-comments";

/**
 * Provider-level contract for the Instagram comment-reply feature
 * (getMediaComments / replyToComment). Mocked Graph, same stub shape as
 * instagram-story-publish.test.ts.
 */

interface Call {
  url: string;
  method: string;
  body?: any;
  signal?: any;
}

function mockGraph(
  handler: (url: string, method: string) => { ok: boolean; status?: number; body: any; unparseable?: boolean }
) {
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
      calls.push({ url: String(url), method, body, signal: init?.signal });
      const { ok, body: res, status, unparseable } = handler(String(url), method);
      return {
        ok,
        status: status ?? (ok ? 200 : 400),
        // Mirrors what res.json() really does on an HTML body.
        json: async () => {
          if (unparseable) throw new SyntaxError("Unexpected token '<', \"<html> <h\"... is not valid JSON");
          return res;
        },
        headers: { get: () => null },
      } as any;
    })
  );
  return calls;
}

const tokens = { accessToken: "IG_PAGE_TOKEN" };

afterEach(() => vi.unstubAllGlobals());

describe("InstagramProvider.getMediaComments", () => {
  it("GETs /{media}/comments with the documented fields + token, and parses the page", async () => {
    const calls = mockGraph(() => ({
      ok: true,
      body: {
        data: [{ id: "c1", text: "hi", timestamp: "t", username: "u", like_count: 1, hidden: false }],
        paging: { cursors: { after: "NEXT" }, next: "https://graph.facebook.com/x" },
      },
    }));
    const p = new InstagramProvider();
    const page = await p.getMediaComments(tokens, "MEDIA_1");

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.pathname.endsWith("/MEDIA_1/comments")).toBe(true);
    expect(url.searchParams.get("fields")).toBe("id,text,timestamp,username,like_count,hidden");
    expect(url.searchParams.get("access_token")).toBe("IG_PAGE_TOKEN");
    expect(url.searchParams.get("after")).toBeNull();
    expect(calls[0]!.method).toBe("GET");
    expect(page).toEqual({
      comments: [{ id: "c1", text: "hi", timestamp: "t", username: "u", likeCount: 1, hidden: false }],
      nextCursor: "NEXT",
    });
  });

  it("forwards the `after` cursor for the next page", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { data: [] } }));
    await new InstagramProvider().getMediaComments(tokens, "MEDIA_1", "CURSOR_A");
    expect(new URL(calls[0]!.url).searchParams.get("after")).toBe("CURSOR_A");
  });

  it("maps Meta's (#10) permission error to the actionable reconnect message", async () => {
    mockGraph(() => ({
      ok: false,
      body: { error: { code: 10, type: "OAuthException", message: "(#10) Application does not have permission for this action" } },
    }));
    await expect(new InstagramProvider().getMediaComments(tokens, "MEDIA_1")).rejects.toThrow(
      COMMENT_PERMISSION_DENIED_MESSAGE
    );
  });

  it("maps #100/33 to the 'comment no longer exists' message", async () => {
    mockGraph(() => ({
      ok: false,
      body: { error: { code: 100, error_subcode: 33, message: "Unsupported get request. Object does not exist" } },
    }));
    await expect(new InstagramProvider().getMediaComments(tokens, "MEDIA_1")).rejects.toThrow(
      COMMENT_OBJECT_GONE_MESSAGE
    );
  });

  it("surfaces any other Graph error verbatim (never a silent empty page)", async () => {
    mockGraph(() => ({ ok: false, body: { error: { code: 4, message: "Application request limit reached" } } }));
    await expect(new InstagramProvider().getMediaComments(tokens, "MEDIA_1")).rejects.toThrow(
      /Instagram comment list failed \(HTTP 400\): .*request limit/
    );
  });

  it("does not let a NON-JSON error body (proxy HTML 502) throw a raw SyntaxError past the classifiers", async () => {
    // The documented failure class: `await res.json()` outside a guard turned a
    // gateway HTML page into an unhandled parse error.
    mockGraph(() => ({ ok: false, status: 502, body: undefined, unparseable: true }) as any);
    await expect(new InstagramProvider().getMediaComments(tokens, "MEDIA_1")).rejects.toThrow(
      /Instagram comment list failed \(HTTP 502\): unreadable response body/
    );
  });

  it("refuses to render an unreadable OK body as an EMPTY comment list", async () => {
    // "No comments yet" for a post with hundreds would be a displayed value the
    // API never reported.
    mockGraph(() => ({ ok: true, status: 200, body: undefined, unparseable: true }) as any);
    await expect(new InstagramProvider().getMediaComments(tokens, "MEDIA_1")).rejects.toThrow(
      /unreadable response while loading comments \(HTTP 200\)/
    );
  });
});

describe("InstagramProvider.replyToComment", () => {
  it("POSTs /{comment}/replies with message + token in the JSON body and returns the new id", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { id: "REPLY_1" } }));
    const res = await new InstagramProvider().replyToComment(tokens, "COMMENT_1", "Thanks!");

    expect(res).toEqual({ id: "REPLY_1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(new URL(calls[0]!.url).pathname.endsWith("/COMMENT_1/replies")).toBe(true);
    // Token travels in the BODY, not the query string — it must never end up in
    // a URL that can be logged or leaked through a referrer.
    expect(new URL(calls[0]!.url).searchParams.get("access_token")).toBeNull();
    expect(calls[0]!.body).toEqual({ message: "Thanks!", access_token: "IG_PAGE_TOKEN" });
  });

  it("maps the permission error on reply too", async () => {
    mockGraph(() => ({
      ok: false,
      body: { error: { code: 10, message: "(#10) Application does not have permission for this action" } },
    }));
    await expect(new InstagramProvider().replyToComment(tokens, "COMMENT_1", "x")).rejects.toThrow(
      COMMENT_PERMISSION_DENIED_MESSAGE
    );
  });

  it("maps a deleted comment (#100/33) on reply to the 'no longer exists' message", async () => {
    mockGraph(() => ({
      ok: false,
      body: { error: { code: 100, error_subcode: 33, message: "Object with ID 'COMMENT_1' does not exist" } },
    }));
    await expect(new InstagramProvider().replyToComment(tokens, "COMMENT_1", "x")).rejects.toThrow(
      COMMENT_OBJECT_GONE_MESSAGE
    );
  });

  it("carries an abort signal (fetchT) so a hung Meta connection cannot hold the web request until nginx 504s", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { id: "REPLY_1" } }));
    await new InstagramProvider().replyToComment(tokens, "COMMENT_1", "x");
    expect(calls[0]!.signal).toBeDefined();
  });

  it("does NOT report a definite failure when an OK response is unreadable — creating a reply is not idempotent", async () => {
    // Same reasoning as AmbiguousPublishError one tier down: calling this a
    // failure invites a retry that posts the reply twice.
    mockGraph(() => ({ ok: true, status: 200, body: undefined, unparseable: true }) as any);
    await expect(new InstagramProvider().replyToComment(tokens, "COMMENT_1", "x")).rejects.toThrow(
      /did not confirm it.*may already be posted/s
    );
  });

  it("treats an OK response with no id the same way (outcome unknown, not a clean failure)", async () => {
    mockGraph(() => ({ ok: true, body: {} }));
    await expect(new InstagramProvider().replyToComment(tokens, "COMMENT_1", "x")).rejects.toThrow(
      /may already be posted/
    );
  });

  it("reports a non-JSON error body with its status instead of a raw SyntaxError", async () => {
    mockGraph(() => ({ ok: false, status: 504, body: undefined, unparseable: true }) as any);
    await expect(new InstagramProvider().replyToComment(tokens, "COMMENT_1", "x")).rejects.toThrow(
      /Instagram comment reply failed \(HTTP 504\): unreadable response body/
    );
  });
});
