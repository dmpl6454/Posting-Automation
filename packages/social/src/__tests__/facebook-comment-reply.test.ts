import { describe, it, expect, vi, afterEach } from "vitest";
import { FacebookProvider } from "../providers/facebook.provider";
import {
  FB_COMMENT_FIELDS,
  FB_COMMENT_FIELDS_MINIMAL,
  FB_COMMENT_LIST_FAILED_MESSAGE,
  FB_COMMENT_PERMISSION_DENIED_MESSAGE,
  FB_COMMENT_REPLY_FAILED_MESSAGE,
  FB_COMMENT_REPLY_UNCONFIRMED_MESSAGE,
  FB_COMMENT_THROTTLED_MESSAGE,
  FB_COMMENT_TOKEN_INVALID_MESSAGE,
} from "../utils/facebook-comments";
import { COMMENT_OBJECT_GONE_MESSAGE } from "../utils/instagram-comments";

/**
 * Provider-level contract for Facebook Page comments (2026-09-23):
 * FacebookProvider.getPostComments / replyToComment against a mocked Graph.
 */

interface Call {
  url: string;
  method: string;
  body?: any;
  signal?: any;
}

type Reply = { ok: boolean; status?: number; body?: any; unparseable?: boolean; throws?: Error };

function mockGraph(handler: (url: string, method: string, n: number) => Reply) {
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
      const r = handler(String(url), method, calls.length);
      if (r.throws) throw r.throws;
      const res: any = {
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 400),
        json: async () => {
          if (r.unparseable) throw new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON");
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

/** Instant sleeps: FacebookProvider paces every Graph call by MIN_REQUEST_GAP_MS. */
function instantSleep() {
  vi.stubGlobal("setTimeout", ((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
}

const tokens = { accessToken: "PAGE_TOKEN" };
const PAGE_ID = "112035290218472";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FacebookProvider.getPostComments", () => {
  it("GETs /{object}/comments top-level, newest first, with the total, embedded replies and the Page token", async () => {
    instantSleep();
    const calls = mockGraph(() => ({
      ok: true,
      body: {
        data: [{ id: "9_1", message: "hi", from: { id: "PSID", name: "A" }, comment_count: 0 }],
        paging: { cursors: { after: "NEXT" }, next: "https://graph.facebook.com/x" },
        summary: { total_count: 1 },
      },
    }));

    const page = await new FacebookProvider().getPostComments(tokens, `${PAGE_ID}_9`, PAGE_ID);

    expect(calls).toHaveLength(1);
    const u = new URL(calls[0]!.url);
    expect(calls[0]!.method).toBe("GET");
    expect(u.pathname.endsWith(`/${PAGE_ID}_9/comments`)).toBe(true);
    expect(u.searchParams.get("fields")).toBe(FB_COMMENT_FIELDS);
    expect(u.searchParams.get("filter")).toBe("toplevel");
    expect(u.searchParams.get("order")).toBe("reverse_chronological");
    expect(u.searchParams.get("summary")).toBe("true");
    expect(u.searchParams.get("access_token")).toBe("PAGE_TOKEN");
    expect(u.searchParams.get("after")).toBeNull();
    expect(page).toMatchObject({ nextCursor: "NEXT", totalCount: 1, comments: [{ id: "9_1", author: { name: "A" } }] });
  });

  it("forwards the cursor and encodes the object id path segment", async () => {
    instantSleep();
    const calls = mockGraph(() => ({ ok: true, body: { data: [] } }));
    await new FacebookProvider().getPostComments(tokens, "123/feed?x=", PAGE_ID, "CURSOR_A");
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get("after")).toBe("CURSOR_A");
    expect(u.pathname.endsWith("/comments")).toBe(true);
    expect(u.pathname).not.toContain("/feed");
  });

  it("bounds the call (abort signal) — it runs in the WEB process", async () => {
    instantSleep();
    const calls = mockGraph(() => ({ ok: true, body: { data: [] } }));
    await new FacebookProvider().getPostComments(tokens, `${PAGE_ID}_9`, PAGE_ID);
    expect(calls[0]!.signal).toBeDefined();
  });

  it("descends ONCE to the minimal field set when Meta rejects a field name, and still returns the thread", async () => {
    instantSleep();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = mockGraph((_u, _m, n) =>
      n === 1
        ? { ok: false, body: { error: { code: 100, message: "(#100) Tried accessing nonexisting field (is_hidden) on node type (Comment)" } } }
        : { ok: true, body: { data: [{ id: "9_1", message: "still here" }] } }
    );

    const page = await new FacebookProvider().getPostComments(tokens, `${PAGE_ID}_9`, PAGE_ID);

    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!.url).searchParams.get("fields")).toBe(FB_COMMENT_FIELDS_MINIMAL);
    expect(page.comments[0]!.text).toBe("still here");
    // The descent is LOUD — it is the only signal Meta changed the schema.
    expect(spy.mock.calls.flat().join(" ")).toMatch(/field rejected/);
  });

  it("does NOT descend on an ordinary #100 (object gone) — no wasted second call", async () => {
    instantSleep();
    const calls = mockGraph(() => ({
      ok: false,
      body: { error: { code: 100, error_subcode: 33, message: "Unsupported get request. Object does not exist" } },
    }));
    await expect(new FacebookProvider().getPostComments(tokens, `${PAGE_ID}_9`, PAGE_ID)).rejects.toThrow(
      COMMENT_OBJECT_GONE_MESSAGE
    );
    expect(calls).toHaveLength(1);
  });

  it("maps the permission family (#10 / #200 / #283) to the actionable reconnect message", async () => {
    instantSleep();
    for (const error of [
      { code: 10, message: "(#10) This endpoint requires the 'pages_read_user_content' permission" },
      { code: 200, message: "(#200) Permissions error" },
      { code: 283, message: "That action requires the extended permission pages_read_engagement and/or pages_read_user_content" },
    ]) {
      mockGraph(() => ({ ok: false, status: 403, body: { error } }));
      await expect(new FacebookProvider().getPostComments(tokens, `${PAGE_ID}_9`, PAGE_ID)).rejects.toThrow(
        FB_COMMENT_PERMISSION_DENIED_MESSAGE
      );
    }
  });

  it("maps a dead token (#190) to 'reconnect', NOT to 'not approved yet'", async () => {
    instantSleep();
    mockGraph(() => ({ ok: false, body: { error: { code: 190, error_subcode: 460, message: "Error validating access token" } } }));
    await expect(new FacebookProvider().getPostComments(tokens, `${PAGE_ID}_9`, PAGE_ID)).rejects.toThrow(
      FB_COMMENT_TOKEN_INVALID_MESSAGE
    );
  });

  it("logs raw Graph JSON server-side but throws a stable message (never renders JSON to the user)", async () => {
    instantSleep();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGraph(() => ({ ok: false, body: { error: { code: 1, message: "An unknown error has occurred." } } }));
    await expect(new FacebookProvider().getPostComments(tokens, `${PAGE_ID}_9`, PAGE_ID)).rejects.toThrow(
      FB_COMMENT_LIST_FAILED_MESSAGE
    );
    expect(spy.mock.calls.flat().join(" ")).toMatch(/unknown error/);
  });

  it("never renders an unreadable OK body as an EMPTY list, nor lets a network failure escape raw", async () => {
    instantSleep();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGraph(() => ({ ok: true, unparseable: true }));
    await expect(new FacebookProvider().getPostComments(tokens, `${PAGE_ID}_9`, PAGE_ID)).rejects.toThrow(
      FB_COMMENT_LIST_FAILED_MESSAGE
    );
    mockGraph(() => ({ ok: false, throws: Object.assign(new Error("aborted due to timeout"), { name: "TimeoutError" }) }));
    await expect(new FacebookProvider().getPostComments(tokens, `${PAGE_ID}_9`, PAGE_ID)).rejects.toThrow(
      FB_COMMENT_LIST_FAILED_MESSAGE
    );
  });
});

describe("FacebookProvider.replyToComment", () => {
  it("POSTs /{comment}/comments with message + Page token in the JSON BODY, returning the new id", async () => {
    instantSleep();
    const calls = mockGraph(() => ({ ok: true, body: { id: "9_77" } }));
    const res = await new FacebookProvider().replyToComment(tokens, "9_55", "Thank you!", PAGE_ID);

    expect(res).toEqual({ id: "9_77" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    const u = new URL(calls[0]!.url);
    expect(u.pathname.endsWith("/9_55/comments")).toBe(true);
    expect(u.searchParams.get("access_token")).toBeNull();
    expect(calls[0]!.body).toEqual({ message: "Thank you!", access_token: "PAGE_TOKEN" });
    expect(calls[0]!.signal).toBeDefined();
  });

  it("🔴 ENCODES commentId so a crafted value cannot retarget the POST to another edge", async () => {
    instantSleep();
    const calls = mockGraph(() => ({ ok: true, body: { id: "x" } }));
    await new FacebookProvider().replyToComment(tokens, `${PAGE_ID}/feed?message=Hacked&x=`, "hi", PAGE_ID);
    const u = new URL(calls[0]!.url);
    expect(u.pathname.endsWith("/comments")).toBe(true);
    expect(u.pathname).not.toContain("/feed");
    expect(u.search).toBe("");
  });

  it("NEVER auto-retries the POST, even on a throttle (creating a reply is not idempotent)", async () => {
    instantSleep();
    const calls = mockGraph(() => ({ ok: false, status: 429, body: { error: { code: 4, message: "Application request limit reached" } } }));
    await expect(new FacebookProvider().replyToComment(tokens, "9_55", "hi", PAGE_ID)).rejects.toThrow(
      FB_COMMENT_THROTTLED_MESSAGE
    );
    expect(calls).toHaveLength(1);
  });

  it("maps #368 (temporarily blocked) to the slow-down message", async () => {
    instantSleep();
    mockGraph(() => ({ ok: false, body: { error: { code: 368, message: "It looks like you were misusing this feature by going too fast." } } }));
    await expect(new FacebookProvider().replyToComment(tokens, "9_55", "hi", PAGE_ID)).rejects.toThrow(
      FB_COMMENT_THROTTLED_MESSAGE
    );
  });

  it("maps the missing pages_manage_engagement permission to the reconnect/not-approved message", async () => {
    instantSleep();
    mockGraph(() => ({ ok: false, status: 403, body: { error: { code: 200, message: "(#200) Requires pages_manage_engagement permission to manage the object" } } }));
    await expect(new FacebookProvider().replyToComment(tokens, "9_55", "hi", PAGE_ID)).rejects.toThrow(
      FB_COMMENT_PERMISSION_DENIED_MESSAGE
    );
  });

  it("maps a deleted comment (#100/33) to 'no longer exists'", async () => {
    instantSleep();
    mockGraph(() => ({ ok: false, body: { error: { code: 100, error_subcode: 33, message: "Object does not exist" } } }));
    await expect(new FacebookProvider().replyToComment(tokens, "9_55", "hi", PAGE_ID)).rejects.toThrow(
      COMMENT_OBJECT_GONE_MESSAGE
    );
  });

  it("reports a definite 4xx refusal as a plain failure", async () => {
    instantSleep();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGraph(() => ({ ok: false, status: 400, body: { error: { code: 1705, message: "There was an error posting to this wall" } } }));
    await expect(new FacebookProvider().replyToComment(tokens, "9_55", "hi", PAGE_ID)).rejects.toThrow(
      FB_COMMENT_REPLY_FAILED_MESSAGE
    );
  });

  it("treats a 5xx, a request that never completed, and an id-less OK as OUTCOME UNKNOWN (may already be posted)", async () => {
    instantSleep();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cases: Reply[] = [
      { ok: false, status: 500, body: { error: { code: 1, message: "An unknown error occurred" } } },
      { ok: false, status: 502, unparseable: true },
      { ok: false, throws: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) },
      { ok: true, body: {} },
      { ok: true, unparseable: true },
    ];
    for (const c of cases) {
      mockGraph(() => c);
      await expect(new FacebookProvider().replyToComment(tokens, "9_55", "hi", PAGE_ID)).rejects.toThrow(
        FB_COMMENT_REPLY_UNCONFIRMED_MESSAGE
      );
    }
  });
});
