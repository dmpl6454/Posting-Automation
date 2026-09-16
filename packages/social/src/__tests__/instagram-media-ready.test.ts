import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Regression guard for the Instagram async-publish race (subcode 2207027,
 * "The media is not ready to be published"). Root cause: the image publish path
 * called media_publish immediately after container creation without waiting for
 * the container to reach FINISHED — only videos waited. Now ALL media waits, and
 * publishContainer additionally retries the transient 2207027 error.
 */
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("@postautomation/db", () => ({}));

import { InstagramProvider } from "../providers/instagram.provider";
import type { OAuthTokens, SocialPostPayload } from "../abstract/social.types";
import { isAmbiguousPublishError, isIndeterminatePublishError } from "../utils/ambiguous-publish";

const tokens: OAuthTokens = {
  accessToken: "tok",
  refreshToken: "ref",
  expiresAt: new Date(Date.now() + 3_600_000),
};

function jsonRes(body: any, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

describe("InstagramProvider — media-ready handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for FINISHED before publishing an image (no immediate publish)", async () => {
    const provider = new InstagramProvider();
    const payload: SocialPostPayload = {
      content: "hello",
      mediaUrls: ["https://media.example.com/a.png"],
      mediaTypes: ["image/png"],
      metadata: { igUserId: "ig-123" },
    } as any;

    // 1) create container, 2) status IN_PROGRESS, 3) status FINISHED,
    // 4) media_publish OK, 5) permalink fetch
    mockFetch
      .mockResolvedValueOnce(jsonRes({ id: "container-1" })) // createMediaContainer
      .mockResolvedValueOnce(jsonRes({ status_code: "IN_PROGRESS" })) // poll 1
      .mockResolvedValueOnce(jsonRes({ status_code: "FINISHED" })) // poll 2
      .mockResolvedValueOnce(jsonRes({ id: "post-1" })) // media_publish
      .mockResolvedValueOnce(jsonRes({ permalink: "https://instagram.com/p/abc" })); // permalink

    const promise = provider.publishPost(tokens, payload);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.platformPostId).toBe("post-1");
    // The status endpoint was polled (image path now waits) — at least one GET
    // to the container status before media_publish.
    const statusCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes("status_code"));
    expect(statusCalls.length).toBeGreaterThanOrEqual(1);
    // media_publish must come AFTER a FINISHED poll, not first.
    const publishIdx = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes("media_publish"));
    const finishedIdx = mockFetch.mock.calls.findIndex((c) => String(c[0]).includes("status_code"));
    expect(publishIdx).toBeGreaterThan(finishedIdx);
  });

  it("retries media_publish on subcode 2207027 then succeeds", async () => {
    const provider = new InstagramProvider();
    const payload: SocialPostPayload = {
      content: "hello",
      mediaUrls: ["https://media.example.com/a.png"],
      mediaTypes: ["image/png"],
      metadata: { igUserId: "ig-123" },
    } as any;

    mockFetch
      .mockResolvedValueOnce(jsonRes({ id: "container-1" })) // create
      .mockResolvedValueOnce(jsonRes({ status_code: "FINISHED" })) // poll → ready
      .mockResolvedValueOnce(
        jsonRes(
          { error: { code: 9007, error_subcode: 2207027, error_user_msg: "The media is not ready to be published." } },
          false,
        ),
      ) // media_publish attempt 1 → not ready
      .mockResolvedValueOnce(jsonRes({ id: "post-1" })) // media_publish attempt 2 → OK
      .mockResolvedValueOnce(jsonRes({ permalink: "https://instagram.com/p/abc" }));

    const promise = provider.publishPost(tokens, payload);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.platformPostId).toBe("post-1");
    const publishCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes("media_publish"));
    expect(publishCalls.length).toBe(2); // retried once
  });

  it("throws immediately on a non-transient publish error (no retry loop)", async () => {
    const provider = new InstagramProvider();
    const payload: SocialPostPayload = {
      content: "hello",
      mediaUrls: ["https://media.example.com/a.png"],
      mediaTypes: ["image/png"],
      metadata: { igUserId: "ig-123" },
    } as any;

    mockFetch
      .mockResolvedValueOnce(jsonRes({ id: "container-1" }))
      .mockResolvedValueOnce(jsonRes({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(
        jsonRes({ error: { code: 190, message: "Invalid OAuth access token" } }, false),
      );

    const promise = provider.publishPost(tokens, payload);
    // Attach the rejection assertion BEFORE draining timers so the rejection is
    // always observed (avoids an unhandled-rejection warning under fake timers).
    const assertion = expect(promise).rejects.toThrow(/Instagram publish failed/);
    await vi.runAllTimersAsync();
    await assertion;
    const publishCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes("media_publish"));
    expect(publishCalls.length).toBe(1); // did NOT retry a non-2207027 error
  });
});

/**
 * waitForMediaReady fail-fast rules (2026-09-16).
 *
 * Measured on prod: a dead IG token's status poll returns a Graph error body with
 * no status_code, which used to be polled for the WHOLE budget (240s for a reel)
 * before a generic "did not finish" — per target, across ~53-channel fan-outs.
 * And a single thrown poll fetch escaped raw on its first occurrence.
 *
 * Everything here runs BEFORE media_publish, so every throw is pre-write. The
 * contract locked below:
 *   1. a dead token / vanished container ends the wait on the FIRST such read;
 *   2. transient read failures are tolerated up to 3 IN A ROW (and consume an
 *      attempt); the 4th throws a DEFINITE error — never one that the duplicate
 *      guard would mistake for a dispatched-but-unconfirmed write;
 *   3. the status GET carries a 15s read timeout.
 */
describe("InstagramProvider — status poll fail-fast (2026-09-16)", () => {
  const videoPayload = (): SocialPostPayload =>
    ({
      content: "reel",
      mediaUrls: ["https://media.example.com/r.mp4"],
      mediaTypes: ["video/mp4"],
      metadata: { igUserId: "ig-123" },
    }) as any;
  const imagePayload = (): SocialPostPayload =>
    ({
      content: "pic",
      mediaUrls: ["https://media.example.com/a.png"],
      mediaTypes: ["image/png"],
      metadata: { igUserId: "ig-123" },
    }) as any;

  const statusCalls = () => mockFetch.mock.calls.filter((c) => String(c[0]).includes("status_code,status"));
  const publishCalls = () => mockFetch.mock.calls.filter((c) => String(c[0]).includes("media_publish"));

  const timeoutErr = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const abortErr = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  const fetchFailed = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  const htmlBody = () =>
    ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON");
      },
    }) as unknown as Response;
  const transientBody = () =>
    jsonRes({ error: { code: 2, is_transient: true, message: "An unexpected error has occurred. Please retry." } }, false);

  /** Queue one "failure" of the given kind onto the ordered fetch mock. */
  type FailureKind = "timeout" | "abort" | "fetchFailed" | "html" | "graph2" | "httpNoBody";
  const queueFailure = (kind: FailureKind) => {
    switch (kind) {
      case "timeout":
        return mockFetch.mockRejectedValueOnce(timeoutErr());
      case "abort":
        return mockFetch.mockRejectedValueOnce(abortErr());
      case "fetchFailed":
        return mockFetch.mockRejectedValueOnce(fetchFailed());
      case "html":
        return mockFetch.mockResolvedValueOnce(htmlBody());
      case "graph2":
        return mockFetch.mockResolvedValueOnce(transientBody());
      case "httpNoBody":
        return mockFetch.mockResolvedValueOnce({ ok: false, status: 504, json: async () => ({}) } as unknown as Response);
    }
  };

  beforeEach(() => {
    // The ordered once-queue survives clearAllMocks; start every case empty.
    mockFetch.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a dead-token body ends the wait on the FIRST read instead of burning the budget", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonRes({ id: "container-1" }))
      .mockResolvedValueOnce(
        jsonRes(
          {
            error: {
              message:
                "Error validating access token: The session has been invalidated because the user changed their password or Facebook has changed the session for security reasons.",
              type: "OAuthException",
              code: 190,
              error_subcode: 460,
              fbtrace_id: "AbC123",
            },
          },
          false,
        ),
      );

    const t0 = Date.now();
    const promise = new InstagramProvider().publishPost(tokens, videoPayload());
    const caught = promise.catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await caught;

    expect(err).toBeInstanceOf(Error);
    // The literal "code":190 survives, so the worker still classifies it as
    // token_expired.
    expect(err.message).toMatch(/^Instagram media status check failed: \{.*"code":190/);
    expect(statusCalls()).toHaveLength(1);
    // One poll interval (5s for video), not the 240s reel budget.
    expect(Date.now() - t0).toBeLessThanOrEqual(5_000);
    expect(publishCalls()).toHaveLength(0);
    // Pre-write ⇒ a definite failure, never an "it may be live" park.
    expect(isAmbiguousPublishError(err)).toBe(false);
    expect(isIndeterminatePublishError(err)).toBe(false);
  });

  it.each([102, 463, 467])("token-invalid code %i also fails on the first read", async (code) => {
    mockFetch
      .mockResolvedValueOnce(jsonRes({ id: "container-1" }))
      .mockResolvedValueOnce(jsonRes({ error: { code, message: "token no longer valid" } }, false));

    const caught = new InstagramProvider().publishPost(tokens, videoPayload()).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await caught;
    expect(err.message).toContain(`"code":${code}`);
    expect(statusCalls()).toHaveLength(1);
  });

  it.each([
    ["#100 subcode 33", { code: 100, error_subcode: 33, type: "GraphMethodException", message: "Unsupported get request. Object with ID 'c' does not exist" }],
    ["#24", { code: 24, error_subcode: 2207008, message: "The media builder does not exist or has expired" }],
  ])("a vanished container (%s) fails on the first read", async (_label, error) => {
    mockFetch
      .mockResolvedValueOnce(jsonRes({ id: "container-1" }))
      .mockResolvedValueOnce(jsonRes({ error }, false));

    const caught = new InstagramProvider().publishPost(tokens, imagePayload()).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await caught;
    expect(err.message).toMatch(/^Instagram media status check failed: /);
    expect(err.message).toContain(`"code":${error.code}`);
    expect(statusCalls()).toHaveLength(1);
    expect(publishCalls()).toHaveLength(0);
  });

  it("#100 WITHOUT subcode 33 is not treated as a vanished container", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonRes({ id: "container-1" }))
      .mockResolvedValueOnce(jsonRes({ error: { code: 100, message: "Invalid parameter" } }, false))
      .mockResolvedValueOnce(jsonRes({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(jsonRes({ id: "post-1" }))
      .mockResolvedValueOnce(jsonRes({ permalink: "https://instagram.com/p/abc" }));

    const promise = new InstagramProvider().publishPost(tokens, imagePayload());
    await vi.runAllTimersAsync();
    expect((await promise).platformPostId).toBe("post-1");
    expect(statusCalls()).toHaveLength(2);
  });

  it("tolerates 3 consecutive unreadable polls, then publishes on FINISHED", async () => {
    mockFetch.mockResolvedValueOnce(jsonRes({ id: "container-1" }));
    queueFailure("fetchFailed");
    queueFailure("html");
    queueFailure("graph2");
    mockFetch
      .mockResolvedValueOnce(jsonRes({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(jsonRes({ id: "post-1" }))
      .mockResolvedValueOnce(jsonRes({ permalink: "https://instagram.com/p/abc" }));

    const promise = new InstagramProvider().publishPost(tokens, videoPayload());
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.platformPostId).toBe("post-1");
    expect(statusCalls()).toHaveLength(4);
    expect(publishCalls()).toHaveLength(1);
  });

  it.each<FailureKind>(["timeout", "abort", "fetchFailed", "html", "graph2", "httpNoBody"])(
    "4 consecutive '%s' failures throw a DEFINITE, pre-write error",
    async (kind) => {
      mockFetch.mockResolvedValueOnce(jsonRes({ id: "container-1" }));
      for (let i = 0; i < 4; i++) queueFailure(kind);

      const caught = new InstagramProvider().publishPost(tokens, videoPayload()).catch((e) => e);
      await vi.runAllTimersAsync();
      const err = await caught;

      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/^Instagram media status could not be read \(4 consecutive errors\): /);
      expect(statusCalls()).toHaveLength(4);
      expect(publishCalls()).toHaveLength(0);

      // ⚠️ The load-bearing part: this must never look like a dispatched write
      // whose outcome is unknown — to the provider-side classifier, to the
      // worker's duplicate guard, or to the worker's inner "fetch failed" /
      // ETIMEDOUT replay loop.
      expect(isAmbiguousPublishError(err)).toBe(false);
      expect(isIndeterminatePublishError(err)).toBe(false);
      expect((err as { cause?: unknown }).cause).toBeUndefined();
      expect(err.message).not.toMatch(/fetch failed|socket hang up|terminated|aborted|timed? ?out|ETIMEDOUT|ECONNRESET|EPIPE|UND_ERR_SOCKET/i);
      expect(err.message).not.toContain("{");
      expect(err.message === "fetch failed" || err.message.includes("ETIMEDOUT")).toBe(false);
    },
  );

  it("describes a read timeout neutrally", async () => {
    mockFetch.mockResolvedValueOnce(jsonRes({ id: "container-1" }));
    for (let i = 0; i < 4; i++) queueFailure("timeout");

    const caught = new InstagramProvider().publishPost(tokens, videoPayload()).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await caught;
    expect(err.message).toBe("Instagram media status could not be read (4 consecutive errors): no response within 15s");
  });

  it("resets the counter after any readable status", async () => {
    mockFetch.mockResolvedValueOnce(jsonRes({ id: "container-1" }));
    queueFailure("timeout");
    queueFailure("graph2");
    queueFailure("html");
    mockFetch.mockResolvedValueOnce(jsonRes({ status_code: "IN_PROGRESS" })); // resets
    queueFailure("fetchFailed");
    queueFailure("abort");
    queueFailure("httpNoBody");
    mockFetch
      .mockResolvedValueOnce(jsonRes({ status_code: "FINISHED" }))
      .mockResolvedValueOnce(jsonRes({ id: "post-1" }))
      .mockResolvedValueOnce(jsonRes({ permalink: "https://instagram.com/p/abc" }));

    const promise = new InstagramProvider().publishPost(tokens, videoPayload());
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.platformPostId).toBe("post-1");
    expect(statusCalls()).toHaveLength(8);
  });

  it("a tolerated failure still consumes an attempt — the budget is never extended", async () => {
    // Image budget: 30s / 2s = 15 attempts. Alternate 3 failures + IN_PROGRESS so
    // the consecutive limit is never reached; the attempt cap must still end it.
    mockFetch.mockResolvedValueOnce(jsonRes({ id: "container-1" }));
    for (let i = 0; i < 15; i++) {
      if (i % 4 === 3) mockFetch.mockResolvedValueOnce(jsonRes({ status_code: "IN_PROGRESS" }));
      else queueFailure("graph2");
    }
    // Anything past the 15th poll would be a budget overrun — make it loud.
    mockFetch.mockResolvedValue(jsonRes({ status_code: "FINISHED" }));

    const caught = new InstagramProvider().publishPost(tokens, imagePayload()).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await caught;

    expect(err.message).toMatch(/did not finish within .*budget 30s/);
    expect(statusCalls()).toHaveLength(15);
    expect(publishCalls()).toHaveLength(0);
  });

  it("ERROR / EXPIRED still fail immediately, exactly as before", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonRes({ id: "container-1" }))
      .mockResolvedValueOnce(jsonRes({ status_code: "ERROR", status: "Error: 2207026" }));

    const caught = new InstagramProvider().publishPost(tokens, videoPayload()).catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await caught;
    expect(err.message).toBe("Instagram media processing failed: Error: 2207026");
    expect(statusCalls()).toHaveLength(1);
  });

  it("the status GET carries a 15s read timeout signal", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    try {
      mockFetch
        .mockResolvedValueOnce(jsonRes({ id: "container-1" }))
        .mockResolvedValueOnce(jsonRes({ status_code: "FINISHED" }))
        .mockResolvedValueOnce(jsonRes({ id: "post-1" }))
        .mockResolvedValueOnce(jsonRes({ permalink: "https://instagram.com/p/abc" }));

      const promise = new InstagramProvider().publishPost(tokens, imagePayload());
      await vi.runAllTimersAsync();
      await promise;

      expect(timeoutSpy).toHaveBeenCalledWith(15_000);
      const [, init] = statusCalls()[0]!;
      expect((init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
      // The WRITE is untouched: media_publish carries no read-timeout signal
      // (aborting a dispatched publish is how an outcome becomes unknown).
      const [, publishInit] = publishCalls()[0]!;
      expect((publishInit as RequestInit | undefined)?.signal).toBeUndefined();
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
