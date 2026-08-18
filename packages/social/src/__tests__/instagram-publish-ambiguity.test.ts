import { describe, it, expect, vi, afterEach } from "vitest";
import { InstagramProvider } from "../providers/instagram.provider";
import { isAmbiguousPublishError } from "../utils/ambiguous-publish";

/**
 * Regression suite for the 2026-08-13 duplicate-post incident.
 *
 * Instagram `media_publish` returned `{"code":2,"is_transient":true}` while
 * HAVING CREATED the post. Measured on production: 11 of 11 targets recorded
 * FAILED were actually live, and `viralpaparazzii` received FIVE copies of the
 * same reel at 20:00/20:02/20:06/20:08/20:10 UTC — bracketing the user's Retry
 * click at 20:04:33.
 *
 * The contract these tests lock:
 *   1. a transient media_publish failure RECONCILES against the account before
 *      giving up, so an already-created post is adopted instead of re-created;
 *   2. when reconciliation cannot prove the outcome, the provider raises
 *      AmbiguousPublishError so the worker parks the target instead of retrying;
 *   3. every OTHER failure path keeps its previous behaviour and call count.
 */

const IG_USER = "17841400000000000";
const CAPTION = "A night dedicated to celebrating Aryan and his craft";

interface Call { url: string; method: string }

function mockGraph(handler: (url: string, method: string) => { ok: boolean; body: any }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: any) => {
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url: String(url), method });
      const { ok, body } = handler(String(url), method);
      return { ok, status: ok ? 200 : 400, json: async () => body, headers: { get: () => null } } as any;
    })
  );
  return calls;
}

/** Makes the provider's backoff sleeps instant so attempt exhaustion is testable. */
function instantSleep() {
  vi.stubGlobal("setTimeout", ((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
}

const TRANSIENT = {
  error: {
    message: "An unexpected error has occurred. Please retry your request later.",
    type: "OAuthException",
    is_transient: true,
    code: 2,
    fbtrace_id: "AXgtZxIYulREP10R9zhI_dx",
  },
};

const mediaListBody = (rows: Array<{ id: string; caption: string; minutesAgo: number }>) => ({
  data: rows.map((r) => ({
    id: r.id,
    timestamp: new Date(Date.now() - r.minutesAgo * 60_000).toISOString(),
    caption: r.caption,
    media_type: "VIDEO",
    media_product_type: "REELS",
    permalink: `https://www.instagram.com/reel/${r.id}/`,
  })),
});

const payload = (content = CAPTION) => ({
  content,
  mediaUrls: ["https://example.com/v.mp4"],
  mediaTypes: ["video/mp4"],
  metadata: { igUserId: IG_USER },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Instagram publish — transient media_publish failure", () => {
  it("adopts the post Instagram already created instead of re-publishing it", async () => {
    // This is the incident, reproduced: media_publish errors transiently, but the
    // reel IS on the account. Before the fix this produced a duplicate on retry.
    const calls = mockGraph((url, method) => {
      if (url.includes("/media_publish")) return { ok: false, body: TRANSIENT };
      if (method === "POST" && url.includes(`/${IG_USER}/media`)) return { ok: true, body: { id: "container-1" } };
      if (url.includes("status_code")) return { ok: true, body: { status_code: "FINISHED" } };
      if (url.includes(`/${IG_USER}/media?`)) {
        return { ok: true, body: mediaListBody([{ id: "18339253048267352", caption: CAPTION, minutesAgo: 1 }]) };
      }
      return { ok: true, body: {} };
    });
    instantSleep();

    const res = await new InstagramProvider().publishPost({ accessToken: "t" }, payload());

    expect(res.platformPostId).toBe("18339253048267352");
    expect(res.url).toContain("18339253048267352");
    // Exactly ONE create attempt reached Instagram — the recovery must not post again.
    expect(calls.filter((c) => c.method === "POST" && c.url.includes(`/${IG_USER}/media`) && !c.url.includes("media_publish"))).toHaveLength(1);
  });

  it("matches a caption that the listing edge truncated at 2000 chars", async () => {
    const long = "x".repeat(2200);
    mockGraph((url, method) => {
      if (url.includes("/media_publish")) return { ok: false, body: TRANSIENT };
      if (method === "POST" && url.includes(`/${IG_USER}/media`)) return { ok: true, body: { id: "c" } };
      if (url.includes("status_code")) return { ok: true, body: { status_code: "FINISHED" } };
      if (url.includes(`/${IG_USER}/media?`)) {
        return { ok: true, body: mediaListBody([{ id: "999", caption: long.slice(0, 2000), minutesAgo: 1 }]) };
      }
      return { ok: true, body: {} };
    });
    instantSleep();

    const res = await new InstagramProvider().publishPost({ accessToken: "t" }, payload(long));
    expect(res.platformPostId).toBe("999");
  });

  it("raises AmbiguousPublishError when the post is provably NOT on the account", async () => {
    // Retrying media_publish with the same creation_id is safe, so the provider
    // exhausts its attempts first; only then does it refuse to guess.
    mockGraph((url, method) => {
      if (url.includes("/media_publish")) return { ok: false, body: TRANSIENT };
      if (method === "POST" && url.includes(`/${IG_USER}/media`)) return { ok: true, body: { id: "c" } };
      if (url.includes("status_code")) return { ok: true, body: { status_code: "FINISHED" } };
      if (url.includes(`/${IG_USER}/media?`)) return { ok: true, body: mediaListBody([]) };
      return { ok: true, body: {} };
    });
    instantSleep();

    const err = await new InstagramProvider().publishPost({ accessToken: "t" }, payload()).catch((e) => e);
    expect(isAmbiguousPublishError(err)).toBe(true);
    expect(String(err.message)).toMatch(/may already/i);
  });

  it("raises AmbiguousPublishError when the account cannot be read at all", async () => {
    // A dead token means we cannot tell — which must never be read as "it failed".
    mockGraph((url, method) => {
      if (url.includes("/media_publish")) return { ok: false, body: TRANSIENT };
      if (method === "POST" && url.includes(`/${IG_USER}/media`)) return { ok: true, body: { id: "c" } };
      if (url.includes("status_code")) return { ok: true, body: { status_code: "FINISHED" } };
      if (url.includes(`/${IG_USER}/media?`)) {
        return { ok: false, body: { error: { code: 190, error_subcode: 460, message: "session invalidated" } } };
      }
      return { ok: true, body: {} };
    });
    instantSleep();

    const err = await new InstagramProvider().publishPost({ accessToken: "t" }, payload()).catch((e) => e);
    expect(isAmbiguousPublishError(err)).toBe(true);
  });

  it("treats a network failure at media_publish as ambiguous, not as a clean failure", async () => {
    let publishCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: any) => {
        const u = String(url);
        const method = (init?.method ?? "GET").toUpperCase();
        if (u.includes("/media_publish")) {
          publishCalls++;
          const e: any = new Error("fetch failed");
          e.cause = { code: "ECONNRESET" };
          throw e;
        }
        if (method === "POST" && u.includes(`/${IG_USER}/media`)) {
          return { ok: true, status: 200, json: async () => ({ id: "c" }), headers: { get: () => null } } as any;
        }
        if (u.includes("status_code")) {
          return { ok: true, status: 200, json: async () => ({ status_code: "FINISHED" }), headers: { get: () => null } } as any;
        }
        return { ok: true, status: 200, json: async () => mediaListBody([]), headers: { get: () => null } } as any;
      })
    );
    instantSleep();

    const err = await new InstagramProvider().publishPost({ accessToken: "t" }, payload()).catch((e) => e);
    expect(isAmbiguousPublishError(err)).toBe(true);
    // A dispatched-but-unacknowledged write must NOT be replayed inside the provider.
    expect(publishCalls).toBe(1);
  });
});

describe("Instagram publish — unchanged failure paths", () => {
  it("a definite Meta rejection still throws a plain Error after ONE publish call", async () => {
    const calls = mockGraph((url, method) => {
      if (url.includes("/media_publish")) {
        return { ok: false, body: { error: { code: 190, message: "Error validating access token" } } };
      }
      if (method === "POST" && url.includes(`/${IG_USER}/media`)) return { ok: true, body: { id: "c" } };
      if (url.includes("status_code")) return { ok: true, body: { status_code: "FINISHED" } };
      return { ok: true, body: {} };
    });
    instantSleep();

    const err = await new InstagramProvider().publishPost({ accessToken: "t" }, payload()).catch((e) => e);
    expect(isAmbiguousPublishError(err)).toBe(false);
    expect(String(err.message)).toContain("Instagram publish failed");
    expect(calls.filter((c) => c.url.includes("/media_publish"))).toHaveLength(1);
    // A definite rejection must not spend a reconciliation read.
    expect(calls.filter((c) => c.url.includes(`/${IG_USER}/media?`))).toHaveLength(0);
  });

  it("still retries the documented not-ready subcode 2207027 without reconciling", async () => {
    let publishAttempts = 0;
    const calls = mockGraph((url, method) => {
      if (url.includes("/media_publish")) {
        publishAttempts++;
        if (publishAttempts < 3) {
          return { ok: false, body: { error: { error_subcode: 2207027, message: "Media ID is not available" } } };
        }
        return { ok: true, body: { id: "18000000000000001" } };
      }
      if (method === "POST" && url.includes(`/${IG_USER}/media`)) return { ok: true, body: { id: "c" } };
      if (url.includes("status_code")) return { ok: true, body: { status_code: "FINISHED" } };
      if (url.includes("permalink")) return { ok: true, body: { permalink: "https://insta/p/1" } };
      return { ok: true, body: {} };
    });
    instantSleep();

    const res = await new InstagramProvider().publishPost({ accessToken: "t" }, payload());
    expect(res.platformPostId).toBe("18000000000000001");
    expect(publishAttempts).toBe(3);
    expect(calls.filter((c) => c.url.includes(`/${IG_USER}/media?`))).toHaveLength(0);
  });
});

describe("Instagram findExistingPost", () => {
  const provider = new InstagramProvider();

  it("finds a matching post inside the window", async () => {
    mockGraph(() => ({ ok: true, body: mediaListBody([{ id: "abc", caption: CAPTION, minutesAgo: 5 }]) }));
    const res = await provider.findExistingPost({ accessToken: "t" }, payload(), new Date(Date.now() - 3_600_000));
    expect(res?.platformPostId).toBe("abc");
  });

  it("returns null when the account has no matching post", async () => {
    mockGraph(() => ({ ok: true, body: mediaListBody([{ id: "abc", caption: "something else entirely", minutesAgo: 5 }]) }));
    const res = await provider.findExistingPost({ accessToken: "t" }, payload(), new Date(Date.now() - 3_600_000));
    expect(res).toBeNull();
  });

  it("throws when the listing is degraded — 'cannot tell' is not 'not published'", async () => {
    mockGraph(() => ({ ok: false, body: { error: { code: 190, error_subcode: 460, message: "session invalidated" } } }));
    await expect(
      provider.findExistingPost({ accessToken: "t" }, payload(), new Date(Date.now() - 3_600_000))
    ).rejects.toThrow();
  });

  it("does not match on a short caption prefix collision", async () => {
    mockGraph(() => ({ ok: true, body: mediaListBody([{ id: "abc", caption: `${CAPTION} — plus a different tail`, minutesAgo: 5 }]) }));
    const res = await provider.findExistingPost({ accessToken: "t" }, payload(), new Date(Date.now() - 3_600_000));
    expect(res).toBeNull();
  });
});

describe("findExistingPost on an EMPTY listing (review finding — HIGH)", () => {
  /**
   * The "an empty first page is inconclusive" heuristic is sound ONLY after a
   * write: we just published there, so the account should not look empty.
   *
   * `findExistingPost` is the PRE-write pre-flight, where an empty listing is the
   * EXPECTED answer — the post genuinely is not there yet. Throwing there made the
   * worker park the target as "may already be live" and stop, so the post was
   * NEVER published and the operator was told something false. That killed BullMQ
   * retries for Instagram and Facebook: the window starts at post.createdAt
   * (minutes old), so any channel that had not posted recently hit it on the first
   * retry of any transient failure.
   */
  it("returns null (safe to publish) when the account has nothing in the window", async () => {
    mockGraph(() => ({ ok: true, body: mediaListBody([]) }));
    const res = await new InstagramProvider().findExistingPost(
      { accessToken: "t" },
      payload(),
      new Date(Date.now() - 600_000)
    );
    expect(res).toBeNull();
  });

  it("still THROWS on an empty listing after a write, where empty is inconclusive", async () => {
    // Same underlying scan, opposite verdict — the context is what differs.
    mockGraph((url, method) => {
      if (url.includes("/media_publish")) return { ok: false, body: TRANSIENT };
      if (method === "POST" && url.includes(`/${IG_USER}/media`)) return { ok: true, body: { id: "c" } };
      if (url.includes("status_code")) return { ok: true, body: { status_code: "FINISHED" } };
      return { ok: true, body: mediaListBody([]) };
    });
    instantSleep();
    const err = await new InstagramProvider().publishPost({ accessToken: "t" }, payload()).catch((e) => e);
    expect(isAmbiguousPublishError(err)).toBe(true);
  });

  it("a DEGRADED listing still throws pre-write — that really is 'cannot tell'", async () => {
    mockGraph(() => ({ ok: false, body: { error: { code: 190, error_subcode: 460, message: "session invalidated" } } }));
    await expect(
      new InstagramProvider().findExistingPost({ accessToken: "t" }, payload(), new Date(Date.now() - 600_000))
    ).rejects.toThrow();
  });
});

describe("Instagram publish — ambiguity must not be lost by a LATER attempt (review, HIGH)", () => {
  it("keeps the ambiguity when a follow-up attempt returns a non-transient error", async () => {
    // Attempt 1 is transient, so the post MAY already exist. Attempt 2 (same
    // creation_id) then returns a definite error — e.g. Meta rejecting a container
    // that has already been consumed. Reporting that as a clean failure would put
    // the target back in the claim set and invite a re-publish of a live post.
    let publishAttempts = 0;
    mockGraph((url, method) => {
      if (url.includes("/media_publish")) {
        publishAttempts++;
        if (publishAttempts === 1) return { ok: false, body: TRANSIENT };
        return { ok: false, body: { error: { code: 100, message: "Invalid parameter" } } };
      }
      if (method === "POST" && url.includes(`/${IG_USER}/media`)) return { ok: true, body: { id: "c" } };
      if (url.includes("status_code")) return { ok: true, body: { status_code: "FINISHED" } };
      return { ok: true, body: mediaListBody([]) };
    });
    instantSleep();

    const err = await new InstagramProvider().publishPost({ accessToken: "t" }, payload()).catch((e) => e);
    expect(isAmbiguousPublishError(err)).toBe(true);
  });

  it("treats a Meta 5xx as indeterminate even when the body looks like a definite error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const u = String(url);
        const method = (init?.method ?? "GET").toUpperCase();
        if (u.includes("/media_publish")) {
          return {
            ok: false,
            status: 503,
            json: async () => ({ error: { code: 1, message: "An unknown error occurred" } }),
            headers: { get: () => null },
          } as any;
        }
        if (method === "POST" && u.includes(`/${IG_USER}/media`)) {
          return { ok: true, status: 200, json: async () => ({ id: "c" }), headers: { get: () => null } } as any;
        }
        if (u.includes("status_code")) {
          return { ok: true, status: 200, json: async () => ({ status_code: "FINISHED" }), headers: { get: () => null } } as any;
        }
        return { ok: true, status: 200, json: async () => mediaListBody([]), headers: { get: () => null } } as any;
      })
    );
    instantSleep();

    const err = await new InstagramProvider().publishPost({ accessToken: "t" }, payload()).catch((e) => e);
    expect(isAmbiguousPublishError(err)).toBe(true);
  });

  it("treats an unparseable response body as indeterminate, not as a clean failure", async () => {
    // A proxy's HTML 502 tells us NOTHING about whether Meta created the post.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init?: any) => {
        const u = String(url);
        const method = (init?.method ?? "GET").toUpperCase();
        if (u.includes("/media_publish")) {
          return {
            ok: false,
            status: 502,
            json: async () => {
              throw new SyntaxError("Unexpected token '<'");
            },
            headers: { get: () => null },
          } as any;
        }
        if (method === "POST" && u.includes(`/${IG_USER}/media`)) {
          return { ok: true, status: 200, json: async () => ({ id: "c" }), headers: { get: () => null } } as any;
        }
        if (u.includes("status_code")) {
          return { ok: true, status: 200, json: async () => ({ status_code: "FINISHED" }), headers: { get: () => null } } as any;
        }
        return { ok: true, status: 200, json: async () => mediaListBody([]), headers: { get: () => null } } as any;
      })
    );
    instantSleep();

    const err = await new InstagramProvider().publishPost({ accessToken: "t" }, payload()).catch((e) => e);
    expect(isAmbiguousPublishError(err)).toBe(true);
  });
});
