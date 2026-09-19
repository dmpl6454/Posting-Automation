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
}

function mockGraph(handler: (url: string, method: string) => { ok: boolean; status?: number; body: any }) {
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
      const { ok, body: res, status } = handler(String(url), method);
      return { ok, status: status ?? (ok ? 200 : 400), json: async () => res, headers: { get: () => null } } as any;
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
      /Instagram comment list failed: .*request limit/
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
});
