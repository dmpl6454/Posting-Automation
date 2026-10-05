import { describe, it, expect, vi, afterEach } from "vitest";
import { InstagramProvider } from "../providers/instagram.provider";
import {
  COMMENT_ACTION_FAILED_MESSAGE,
  COMMENT_MEDIA_GONE_MESSAGE,
  COMMENT_PERMISSION_DENIED_MESSAGE,
  COMMENT_TOKEN_INVALID_MESSAGE,
} from "../utils/instagram-comments";
import { COMMENT_ACTION_UNCONFIRMED_MESSAGE } from "../utils/social-comments";

/**
 * Instagram comments on/off (2026-10-05) — IG Media reference:
 *   read   GET  /{ig-media-id}?fields=is_comment_enabled
 *   update POST /{ig-media-id} {comment_enabled: true|false} → {success:true}
 * Mocked Graph.
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
const MEDIA = "18047431234567890";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("InstagramProvider.setMediaCommentsEnabled", () => {
  it("POSTs comment_enabled to the MEDIA node (JSON body, token in the body, id URL-encoded)", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { success: true } }));
    await new InstagramProvider().setMediaCommentsEnabled(tokens, MEDIA, false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toMatch(new RegExp(`/${MEDIA}$`));
    expect(calls[0]!.body).toEqual({ comment_enabled: false, access_token: "USER_TOKEN" });
  });

  it("switching back on sends comment_enabled: true", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { success: true } }));
    await new InstagramProvider().setMediaCommentsEnabled(tokens, MEDIA, true);
    expect(calls[0]!.body.comment_enabled).toBe(true);
  });

  it("#100/33 means the POST is gone — never 'that comment no longer exists'", async () => {
    mockGraph(() => ({ ok: false, body: { error: { code: 100, error_subcode: 33, message: "Unsupported post request. Object does not exist" } } }));
    await expect(new InstagramProvider().setMediaCommentsEnabled(tokens, MEDIA, false)).rejects.toThrow(COMMENT_MEDIA_GONE_MESSAGE);
  });

  it("a missing permission and a dead token use the shared actionable messages", async () => {
    mockGraph(() => ({ ok: false, body: { error: { code: 10, message: "Application does not have permission for this action" } } }));
    await expect(new InstagramProvider().setMediaCommentsEnabled(tokens, MEDIA, false)).rejects.toThrow(COMMENT_PERMISSION_DENIED_MESSAGE);
    mockGraph(() => ({ ok: false, body: { error: { code: 190, message: "Error validating access token" } } }));
    await expect(new InstagramProvider().setMediaCommentsEnabled(tokens, MEDIA, false)).rejects.toThrow(COMMENT_TOKEN_INVALID_MESSAGE);
  });

  it("a 5xx or a request that never completed is UNCONFIRMED, not failed", async () => {
    mockGraph(() => ({ ok: false, status: 502, unparseable: true }));
    await expect(new InstagramProvider().setMediaCommentsEnabled(tokens, MEDIA, false)).rejects.toThrow(COMMENT_ACTION_UNCONFIRMED_MESSAGE);
    mockGraph(() => ({ ok: false, throws: new Error("socket hang up") }));
    await expect(new InstagramProvider().setMediaCommentsEnabled(tokens, MEDIA, false)).rejects.toThrow(COMMENT_ACTION_UNCONFIRMED_MESSAGE);
  });

  it("an OK body saying success:false is a failure", async () => {
    mockGraph(() => ({ ok: true, body: { success: false } }));
    await expect(new InstagramProvider().setMediaCommentsEnabled(tokens, MEDIA, false)).rejects.toThrow(COMMENT_ACTION_FAILED_MESSAGE);
  });
});

describe("InstagramProvider.getMediaCommentsEnabled", () => {
  it("reads is_comment_enabled from the media node", async () => {
    const calls = mockGraph(() => ({ ok: true, body: { is_comment_enabled: false, id: MEDIA } }));
    await expect(new InstagramProvider().getMediaCommentsEnabled(tokens, MEDIA)).resolves.toBe(false);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toContain(`/${MEDIA}?`);
    expect(calls[0]!.url).toContain("fields=is_comment_enabled");
  });

  it("never throws — an error, a missing field or a network failure is null (unknown)", async () => {
    mockGraph(() => ({ ok: false, body: { error: { code: 10, message: "nope" } } }));
    await expect(new InstagramProvider().getMediaCommentsEnabled(tokens, MEDIA)).resolves.toBeNull();
    mockGraph(() => ({ ok: true, body: { id: MEDIA } }));
    await expect(new InstagramProvider().getMediaCommentsEnabled(tokens, MEDIA)).resolves.toBeNull();
    mockGraph(() => ({ ok: false, throws: new Error("timeout") }));
    await expect(new InstagramProvider().getMediaCommentsEnabled(tokens, MEDIA)).resolves.toBeNull();
  });
});
