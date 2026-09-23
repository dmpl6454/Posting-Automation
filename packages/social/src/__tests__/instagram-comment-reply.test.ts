import { describe, it, expect, vi, afterEach } from "vitest";
import { InstagramProvider } from "../providers/instagram.provider";
import {
  COMMENT_PERMISSION_DENIED_MESSAGE,
  COMMENT_OBJECT_GONE_MESSAGE,
  COMMENT_LIST_FAILED_MESSAGE,
  COMMENT_REPLY_FAILED_MESSAGE,
  COMMENT_REPLY_UNCONFIRMED_MESSAGE,
  IG_COMMENT_FIELDS,
  IG_COMMENT_FIELDS_MINIMAL,
  COMMENT_MEDIA_GONE_MESSAGE,
  COMMENT_TOKEN_INVALID_MESSAGE,
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
    // Embeds the first page of replies (and each author's id) in the same
    // round-trip, so the account's own reply shows up right after sending.
    expect(url.searchParams.get("fields")).toBe(IG_COMMENT_FIELDS);
    expect(IG_COMMENT_FIELDS).toContain("replies{");
    expect(IG_COMMENT_FIELDS).toContain("from{id,username}");
    expect(url.searchParams.get("access_token")).toBe("IG_PAGE_TOKEN");
    expect(url.searchParams.get("after")).toBeNull();
    expect(calls[0]!.method).toBe("GET");
    expect(page).toMatchObject({
      comments: [{ id: "c1", text: "hi", createdAt: "t", author: { username: "u" }, likeCount: 1, hidden: false }],
      nextCursor: "NEXT",
      totalCount: null,
    });
  });

  it("descends ONCE to the minimal (2026-09-19) field set when Meta rejects a field name", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let n = 0;
    const calls = mockGraph(() =>
      ++n === 1
        ? { ok: false, body: { error: { code: 100, message: "(#100) Tried accessing nonexisting field (from) on node type (IGComment)" } } }
        : { ok: true, body: { data: [{ id: "c1", text: "still here", username: "fan" }] } }
    );
    const page = await new InstagramProvider().getMediaComments(tokens, "MEDIA_1");
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!.url).searchParams.get("fields")).toBe(IG_COMMENT_FIELDS_MINIMAL);
    expect(page.comments[0]!.text).toBe("still here");
    expect(spy.mock.calls.flat().join(" ")).toMatch(/field rejected/);
    spy.mockRestore();
  });

  it("forwards the `after` cursor for the next page", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { data: [] } }));
    await new InstagramProvider().getMediaComments(tokens, "MEDIA_1", "CURSOR_A");
    expect(new URL(calls[0]!.url).searchParams.get("after")).toBe("CURSOR_A");
  });

  it("encodes the media id path segment too (defence in depth for a future caller)", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { data: [] } }));
    await new InstagramProvider().getMediaComments(tokens, "123/insights?metric=x&");
    const u = new URL(calls[0]!.url);
    expect(u.pathname.endsWith("/comments")).toBe(true);
    expect(u.pathname).not.toContain("/insights");
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

  it("maps #100/33 on the LIST call to 'this post is no longer available' (changed 2026-09-23)", async () => {
    // Until 2026-09-23 this said "That comment no longer exists" — but on the
    // list call the object that is gone is the MEDIA, not a comment.
    mockGraph(() => ({
      ok: false,
      body: { error: { code: 100, error_subcode: 33, message: "Unsupported get request. Object does not exist" } },
    }));
    await expect(new InstagramProvider().getMediaComments(tokens, "MEDIA_1")).rejects.toThrow(
      COMMENT_MEDIA_GONE_MESSAGE
    );
  });

  it("maps a dead token (#190) to 'reconnect' on list and reply, not 'try again'", async () => {
    mockGraph(() => ({ ok: false, body: { error: { code: 190, error_subcode: 460, message: "Error validating access token" } } }));
    await expect(new InstagramProvider().getMediaComments(tokens, "MEDIA_1")).rejects.toThrow(COMMENT_TOKEN_INVALID_MESSAGE);
    await expect(new InstagramProvider().replyToComment(tokens, "COMMENT_1", "x")).rejects.toThrow(
      COMMENT_TOKEN_INVALID_MESSAGE
    );
  });

  it("does NOT render raw Graph JSON to the user — logs it, throws a stable message", async () => {
    // humanizeError does not recognise `{"error":{...}}` as technical, so a raw
    // Graph body in the thrown message reaches the UI verbatim.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGraph(() => ({ ok: false, body: { error: { code: 4, message: "Application request limit reached" } } }));
    await expect(new InstagramProvider().getMediaComments(tokens, "MEDIA_1")).rejects.toThrow(
      COMMENT_LIST_FAILED_MESSAGE
    );
    // The detail is not lost — it goes to the server log.
    expect(spy.mock.calls.flat().join(" ")).toMatch(/request limit/);
    spy.mockRestore();
  });

  it("does not let a NON-JSON error body (proxy HTML 502) throw a raw SyntaxError past the classifiers", async () => {
    // The documented failure class: `await res.json()` outside a guard turned a
    // gateway HTML page into an unhandled parse error.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGraph(() => ({ ok: false, status: 502, body: undefined, unparseable: true }) as any);
    await expect(new InstagramProvider().getMediaComments(tokens, "MEDIA_1")).rejects.toThrow(
      COMMENT_LIST_FAILED_MESSAGE
    );
    expect(spy.mock.calls.flat().join(" ")).toMatch(/502|unreadable/);
    spy.mockRestore();
  });

  it("maps a list request that never completed to the stable list-failed message (no raw AbortError)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }));
    await expect(new InstagramProvider().getMediaComments(tokens, "MEDIA_1")).rejects.toThrow(
      COMMENT_LIST_FAILED_MESSAGE
    );
    spy.mockRestore();
  });

  it("refuses to render an unreadable OK body as an EMPTY comment list", async () => {
    // "No comments yet" for a post with hundreds would be a displayed value the
    // API never reported.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGraph(() => ({ ok: true, status: 200, body: undefined, unparseable: true }) as any);
    await expect(new InstagramProvider().getMediaComments(tokens, "MEDIA_1")).rejects.toThrow(
      COMMENT_LIST_FAILED_MESSAGE
    );
    spy.mockRestore();
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

  it("reports a non-JSON 4xx error body with its status instead of a raw SyntaxError", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGraph(() => ({ ok: false, status: 400, body: undefined, unparseable: true }) as any);
    await expect(new InstagramProvider().replyToComment(tokens, "COMMENT_1", "x")).rejects.toThrow(
      COMMENT_REPLY_FAILED_MESSAGE
    );
    expect(spy.mock.calls.flat().join(" ")).toMatch(/400|unreadable/);
    spy.mockRestore();
  });

  it("treats ANY 5xx on reply as outcome-unknown, not failed (changed 2026-09-23)", async () => {
    // Until 2026-09-23 a 504 read as a plain failure. A 5xx is indeterminate
    // whatever the body says (CLAUDE.md, 2026-08-18 duplicate-post lessons):
    // the reply may be live, and "failed" invites a retry that double-posts.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const status of [500, 502, 504]) {
      mockGraph(() => ({ ok: false, status, body: undefined, unparseable: true }) as any);
      await expect(new InstagramProvider().replyToComment(tokens, "COMMENT_1", "x")).rejects.toThrow(
        COMMENT_REPLY_UNCONFIRMED_MESSAGE
      );
    }
    mockGraph(() => ({ ok: false, status: 500, body: { error: { code: 1, message: "An unknown error occurred" } } }));
    await expect(new InstagramProvider().replyToComment(tokens, "COMMENT_1", "x")).rejects.toThrow(
      COMMENT_REPLY_UNCONFIRMED_MESSAGE
    );
    spy.mockRestore();
  });

  it("treats a 4xx carrying is_transient / code 2 as outcome-unknown (throttles excepted)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGraph(() => ({ ok: false, status: 400, body: { error: { code: 2, is_transient: true, message: "Please retry your request later." } } }));
    await expect(new InstagramProvider().replyToComment(tokens, "COMMENT_1", "x")).rejects.toThrow(
      COMMENT_REPLY_UNCONFIRMED_MESSAGE
    );
    mockGraph(() => ({ ok: false, status: 400, body: { error: { code: 4, is_transient: true, message: "Application request limit reached" } } }));
    await expect(new InstagramProvider().replyToComment(tokens, "COMMENT_1", "x")).rejects.toThrow(
      COMMENT_REPLY_FAILED_MESSAGE
    );
    spy.mockRestore();
  });

  it("treats a request that never completed (timeout/reset) as outcome-unknown", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }));
    await expect(new InstagramProvider().replyToComment(tokens, "COMMENT_1", "x")).rejects.toThrow(
      COMMENT_REPLY_UNCONFIRMED_MESSAGE
    );
    spy.mockRestore();
  });

  it("🔴 ENCODES commentId so a crafted value cannot retarget the Graph edge", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { id: "REPLY_1" } }));
    const evil = "17841400000000000/media?image_url=https%3A%2F%2Fevil.example%2Fx.jpg&caption=Hacked&x=";
    await new InstagramProvider().replyToComment(tokens, evil, "x");

    const u = new URL(calls[0]!.url);
    // Without encoding this resolves to /v18.0/17841400000000000/media and the
    // POST lands on the Create-Media edge, authenticated by the org's token.
    expect(u.pathname.endsWith("/replies")).toBe(true);
    expect(u.pathname).not.toContain("/media");
    expect(u.search).toBe("");
  });
});
