import { describe, it, expect, vi, afterEach } from "vitest";
import { FacebookProvider } from "../providers/facebook.provider";
import { isAmbiguousPublishError } from "../utils/ambiguous-publish";

/**
 * Facebook half of the 2026-08-13 duplicate-post fix.
 *
 * Facebook was NOT the platform that duplicated in that incident (its 41 failed
 * targets were genuine token expiries — measured, 0 of 41 were live). It gets the
 * same guard anyway, because the defect was never Instagram-specific: it is
 * "re-run a non-idempotent create after an error that only proves the REQUEST
 * failed". `/{page}/feed` and `/{page}/videos` are exactly as non-idempotent.
 *
 * The wrapper must be INVISIBLE on success and on definite rejections — the
 * existing facebook-video suite asserts exact Graph call counts and is the
 * regression gate for that.
 */

const tokens = { accessToken: "tok" };
const MESSAGE = "Happy Independence Day #HappyIndependenceDay #15August";

const jsonRes = (body: any, ok = true) =>
  ({ ok, status: ok ? 200 : 400, json: async () => body, clone: () => jsonRes(body, ok), headers: { get: () => null } }) as any;

const TRANSIENT = {
  error: { message: "An unexpected error has occurred.", type: "OAuthException", is_transient: true, code: 2 },
};

const publishedPostsBody = (rows: Array<{ id: string; message: string; minutesAgo: number }>) => ({
  data: rows.map((r) => ({
    id: r.id,
    created_time: new Date(Date.now() - r.minutesAgo * 60_000).toISOString(),
    message: r.message,
    permalink_url: `https://www.facebook.com/${r.id}`,
    status_type: "mobile_status_update",
  })),
});

/** Instant sleeps: FacebookProvider paces every Graph call by MIN_REQUEST_GAP_MS. */
function instantSleep() {
  vi.stubGlobal("setTimeout", ((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
}

const textPayload = { content: MESSAGE, metadata: { pageId: "PAGE1" } };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Facebook publish — transient failure reconciliation", () => {
  it("adopts a post Facebook already created instead of writing again", async () => {
    const writes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes("/PAGE1/feed") && init?.method === "POST") {
          writes.push(u);
          return jsonRes(TRANSIENT, false);
        }
        if (u.includes("/published_posts")) {
          return jsonRes(publishedPostsBody([{ id: "PAGE1_555", message: MESSAGE, minutesAgo: 1 }]));
        }
        return jsonRes({});
      })
    );
    instantSleep();

    const res = await new FacebookProvider().publishPost(tokens, textPayload);

    expect(res.platformPostId).toBe("PAGE1_555");
    expect(writes).toHaveLength(1); // exactly one create attempt reached Facebook
  });

  it("raises AmbiguousPublishError when the outcome cannot be established", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes("/PAGE1/feed") && init?.method === "POST") return jsonRes(TRANSIENT, false);
        if (u.includes("/published_posts")) return jsonRes(publishedPostsBody([]));
        return jsonRes({});
      })
    );
    instantSleep();

    const err = await new FacebookProvider().publishPost(tokens, textPayload).catch((e) => e);
    expect(isAmbiguousPublishError(err)).toBe(true);
  });

  it("treats a mid-flight network failure on the write as ambiguous", async () => {
    let writes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes("/PAGE1/feed") && init?.method === "POST") {
          writes++;
          const e: any = new Error("fetch failed");
          e.cause = { code: "ETIMEDOUT" };
          throw e;
        }
        if (u.includes("/published_posts")) return jsonRes(publishedPostsBody([]));
        return jsonRes({});
      })
    );
    instantSleep();

    const err = await new FacebookProvider().publishPost(tokens, textPayload).catch((e) => e);
    expect(isAmbiguousPublishError(err)).toBe(true);
    expect(writes).toBe(1);
  });
});

describe("Facebook publish — paths that must stay byte-identical", () => {
  it("success needs no reconciliation read at all", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        urls.push(String(url));
        return jsonRes({ id: "PAGE1_777" });
      })
    );
    instantSleep();

    const res = await new FacebookProvider().publishPost(tokens, textPayload);
    expect(res.platformPostId).toBe("PAGE1_777");
    expect(urls.filter((u) => u.includes("/published_posts"))).toHaveLength(0);
  });

  it("a definite rejection throws the original error and spends no reconciliation read", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any) => {
        urls.push(String(url));
        return jsonRes({ error: { code: 190, message: "Error validating access token" } }, false);
      })
    );
    instantSleep();

    const err = await new FacebookProvider().publishPost(tokens, textPayload).catch((e) => e);
    expect(isAmbiguousPublishError(err)).toBe(false);
    expect(String(err.message)).toContain("Facebook post failed");
    expect(urls.filter((u) => u.includes("/published_posts"))).toHaveLength(0);
  });
});

describe("Facebook findExistingPost", () => {
  it("returns the matching post", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(publishedPostsBody([{ id: "PAGE1_1", message: MESSAGE, minutesAgo: 3 }])))
    );
    instantSleep();
    const res = await new FacebookProvider().findExistingPost(tokens, textPayload, new Date(Date.now() - 3_600_000));
    expect(res?.platformPostId).toBe("PAGE1_1");
  });

  it("returns null when the page is readable and has no such post", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes(publishedPostsBody([{ id: "PAGE1_1", message: "unrelated", minutesAgo: 3 }])))
    );
    instantSleep();
    const res = await new FacebookProvider().findExistingPost(tokens, textPayload, new Date(Date.now() - 3_600_000));
    expect(res).toBeNull();
  });

  it("throws when the page cannot be read — 'cannot tell' is not 'not published'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRes({ error: { code: 190, error_subcode: 460, message: "session invalidated" } }, false))
    );
    instantSleep();
    await expect(
      new FacebookProvider().findExistingPost(tokens, textPayload, new Date(Date.now() - 3_600_000))
    ).rejects.toThrow();
  });
});
