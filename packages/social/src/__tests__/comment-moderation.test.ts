import { describe, it, expect, vi, afterEach } from "vitest";
import { FacebookProvider } from "../providers/facebook.provider";
import { InstagramProvider } from "../providers/instagram.provider";
import {
  FB_COMMENT_ACTION_FAILED_MESSAGE,
  FB_COMMENT_PERMISSION_DENIED_MESSAGE,
  FB_COMMENT_TOKEN_INVALID_MESSAGE,
} from "../utils/facebook-comments";
import {
  COMMENT_ACTION_FAILED_MESSAGE,
  COMMENT_OBJECT_GONE_MESSAGE,
  COMMENT_PERMISSION_DENIED_MESSAGE,
} from "../utils/instagram-comments";
import { COMMENT_ACTION_UNCONFIRMED_MESSAGE } from "../utils/social-comments";

/**
 * Comment moderation (2026-09-23): hide / unhide / delete (FB + IG), like /
 * unlike / edit-own (FB), and the IG comment→media lookup that scopes writes
 * to the target's own media. Mocked Graph.
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

function instantSleep() {
  vi.stubGlobal("setTimeout", ((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
}

const tokens = { accessToken: "TOKEN" };
const PAGE = "112035290218472";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FacebookProvider moderation", () => {
  it("hide/unhide = POST /{comment} {is_hidden} with the token in the BODY", async () => {
    instantSleep();
    const calls = mockGraph(() => ({ ok: true, body: { success: true } }));
    await new FacebookProvider().setCommentHidden(tokens, "9_55", true, PAGE);
    await new FacebookProvider().setCommentHidden(tokens, "9_55", false, PAGE);
    expect(calls.map((c) => [c.method, new URL(c.url).pathname.split("/").pop()])).toEqual([
      ["POST", "9_55"],
      ["POST", "9_55"],
    ]);
    expect(calls[0]!.body).toEqual({ is_hidden: true, access_token: "TOKEN" });
    expect(calls[1]!.body).toEqual({ is_hidden: false, access_token: "TOKEN" });
    expect(new URL(calls[0]!.url).searchParams.get("access_token")).toBeNull();
  });

  it("delete = DELETE /{comment}", async () => {
    instantSleep();
    const calls = mockGraph(() => ({ ok: true, body: { success: true } }));
    await new FacebookProvider().deleteComment(tokens, "9_55", PAGE);
    expect(calls[0]!.method).toBe("DELETE");
    expect(new URL(calls[0]!.url).pathname.endsWith("/9_55")).toBe(true);
  });

  it("like = POST /{comment}/likes, unlike = DELETE /{comment}/likes", async () => {
    instantSleep();
    const calls = mockGraph(() => ({ ok: true, body: { success: true } }));
    await new FacebookProvider().setCommentLiked(tokens, "9_55", true, PAGE);
    await new FacebookProvider().setCommentLiked(tokens, "9_55", false, PAGE);
    expect(calls.map((c) => [c.method, new URL(c.url).pathname.endsWith("/9_55/likes")])).toEqual([
      ["POST", true],
      ["DELETE", true],
    ]);
  });

  it("edit = POST /{comment} {message}", async () => {
    instantSleep();
    const calls = mockGraph(() => ({ ok: true, body: { success: true } }));
    await new FacebookProvider().editComment(tokens, "9_77", "Fixed typo", PAGE);
    expect(calls[0]!.body).toEqual({ message: "Fixed typo", access_token: "TOKEN" });
  });

  it("🔴 encodes the comment id so a crafted value cannot retarget the call", async () => {
    instantSleep();
    const calls = mockGraph(() => ({ ok: true, body: { success: true } }));
    await new FacebookProvider().deleteComment(tokens, `${PAGE}/feed?x=`, PAGE);
    expect(new URL(calls[0]!.url).pathname).not.toContain("/feed");
  });

  it("maps permission, dead token and an explicit success:false", async () => {
    instantSleep();
    mockGraph(() => ({ ok: false, status: 400, body: { error: { code: 100, message: "(#100) Missing Permission" } } }));
    await expect(new FacebookProvider().deleteComment(tokens, "9_55", PAGE)).rejects.toThrow(FB_COMMENT_PERMISSION_DENIED_MESSAGE);
    mockGraph(() => ({ ok: false, status: 400, body: { error: { code: 190, message: "expired" } } }));
    await expect(new FacebookProvider().setCommentHidden(tokens, "9_55", true, PAGE)).rejects.toThrow(FB_COMMENT_TOKEN_INVALID_MESSAGE);
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGraph(() => ({ ok: true, body: { success: false } }));
    await expect(new FacebookProvider().setCommentLiked(tokens, "9_55", true, PAGE)).rejects.toThrow(FB_COMMENT_ACTION_FAILED_MESSAGE);
  });

  it("an unknown outcome (5xx, transient, dropped request) says 'refresh to see', never auto-retries", async () => {
    instantSleep();
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const r of [
      { ok: false, status: 502, unparseable: true },
      { ok: false, status: 400, body: { error: { code: 2, is_transient: true } } },
      { ok: false, throws: new Error("socket hang up") },
    ] as Reply[]) {
      const calls = mockGraph(() => r);
      await expect(new FacebookProvider().deleteComment(tokens, "9_55", PAGE)).rejects.toThrow(COMMENT_ACTION_UNCONFIRMED_MESSAGE);
      expect(calls).toHaveLength(1);
    }
  });
});

describe("InstagramProvider moderation", () => {
  it("getCommentMediaId reads media{id} and returns null for a deleted comment", async () => {
    let calls = mockGraph(() => ({ ok: true, body: { id: "c1", media: { id: "MEDIA_1" } } }));
    expect(await new InstagramProvider().getCommentMediaId(tokens, "c1")).toBe("MEDIA_1");
    expect(new URL(calls[0]!.url).searchParams.get("fields")).toBe("id,media{id}");
    calls = mockGraph(() => ({ ok: false, body: { error: { code: 100, error_subcode: 33, message: "does not exist" } } }));
    expect(await new InstagramProvider().getCommentMediaId(tokens, "c1")).toBeNull();
  });

  it("getCommentMediaId surfaces a missing permission instead of pretending the comment is fine", async () => {
    mockGraph(() => ({ ok: false, body: { error: { code: 100, message: "(#100) Missing Permission" } } }));
    await expect(new InstagramProvider().getCommentMediaId(tokens, "c1")).rejects.toThrow(COMMENT_PERMISSION_DENIED_MESSAGE);
  });

  it("hide/unhide = POST /{comment} {hide}; delete = DELETE /{comment}", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { success: true } }));
    await new InstagramProvider().setCommentHidden(tokens, "c1", true);
    await new InstagramProvider().setCommentHidden(tokens, "c1", false);
    await new InstagramProvider().deleteComment(tokens, "c1");
    expect(calls[0]!.body).toEqual({ hide: true, access_token: "TOKEN" });
    expect(calls[1]!.body).toEqual({ hide: false, access_token: "TOKEN" });
    expect(calls[2]!.method).toBe("DELETE");
  });

  it("maps errors: permission, gone, unknown outcome, generic", async () => {
    mockGraph(() => ({ ok: false, body: { error: { code: 10, message: "(#10) Application does not have permission for this action" } } }));
    await expect(new InstagramProvider().deleteComment(tokens, "c1")).rejects.toThrow(COMMENT_PERMISSION_DENIED_MESSAGE);
    mockGraph(() => ({ ok: false, body: { error: { code: 100, error_subcode: 33, message: "does not exist" } } }));
    await expect(new InstagramProvider().setCommentHidden(tokens, "c1", true)).rejects.toThrow(COMMENT_OBJECT_GONE_MESSAGE);
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGraph(() => ({ ok: false, status: 504, unparseable: true }));
    await expect(new InstagramProvider().deleteComment(tokens, "c1")).rejects.toThrow(COMMENT_ACTION_UNCONFIRMED_MESSAGE);
    mockGraph(() => ({ ok: false, status: 400, body: { error: { code: 1, message: "Something" } } }));
    await expect(new InstagramProvider().deleteComment(tokens, "c1")).rejects.toThrow(COMMENT_ACTION_FAILED_MESSAGE);
  });
});
