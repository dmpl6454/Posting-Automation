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
