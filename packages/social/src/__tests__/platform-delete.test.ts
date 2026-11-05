import { describe, it, expect, vi, afterEach } from "vitest";
import {
  classifyPlatformDeleteResponse,
  platformDeleteCapability,
  isPlatformDeletePlatform,
} from "../utils/platform-delete";
import { InstagramProvider } from "../providers/instagram.provider";
import { FacebookProvider } from "../providers/facebook.provider";

/**
 * Delete from Facebook / Instagram (2026-11-05). Deleting is idempotent, so an
 * unknown outcome is "retry", never a guess; a refusal never carries raw Graph
 * JSON; "#100/33" is "gone or unreachable", never "deleted".
 */

describe("classifyPlatformDeleteResponse", () => {
  it("2xx success → deleted (both Facebook and Instagram bodies)", () => {
    expect(classifyPlatformDeleteResponse("FACEBOOK", 200, { success: true }).kind).toBe("deleted");
    expect(classifyPlatformDeleteResponse("INSTAGRAM", 200, { success: true, deleted_id: "1" }).kind).toBe("deleted");
  });

  it("an explicit success:false is a refusal, not a delete", () => {
    expect(classifyPlatformDeleteResponse("FACEBOOK", 200, { success: false }).kind).toBe("refused");
  });

  it("network failure, 5xx, throttles and is_transient are retryable", () => {
    expect(classifyPlatformDeleteResponse("FACEBOOK", 0, null).kind).toBe("retry");
    expect(classifyPlatformDeleteResponse("FACEBOOK", 502, null).kind).toBe("retry");
    expect(classifyPlatformDeleteResponse("FACEBOOK", 400, { error: { code: 4, message: "(#4) Application request limit reached", is_transient: true } }).kind).toBe("retry");
    expect(classifyPlatformDeleteResponse("INSTAGRAM", 400, { error: { code: 2, is_transient: true } }).kind).toBe("retry");
    expect(classifyPlatformDeleteResponse("INSTAGRAM", 429, "<html>").kind).toBe("retry");
  });

  it("a dead token asks for a reconnect", () => {
    const o = classifyPlatformDeleteResponse("INSTAGRAM", 400, { error: { code: 190, error_subcode: 460, message: "Session invalidated" } });
    expect(o).toMatchObject({ kind: "refused", reason: "reconnect" });
  });

  it("#100/33 is 'gone or unreachable' — never reported as deleted", () => {
    const o = classifyPlatformDeleteResponse("FACEBOOK", 400, {
      error: { code: 100, error_subcode: 33, message: "Unsupported delete request. Object with ID '1_2' does not exist, cannot be loaded due to missing permissions" },
    });
    expect(o.kind).toBe("not_found");
  });

  it("Instagram 2207073 (ads, carousel children) is unsupported", () => {
    const o = classifyPlatformDeleteResponse("INSTAGRAM", 400, { error: { code: 100, error_subcode: 2207073, message: "Media Type Not Supported" } });
    expect(o).toMatchObject({ kind: "refused", reason: "unsupported" });
  });

  it("a permission error names the missing permission, and never echoes the Graph body", () => {
    const o = classifyPlatformDeleteResponse("INSTAGRAM", 403, { error: { code: 10, message: "(#10) Application does not have permission for this action", fbtrace_id: "Axyz" } });
    expect(o).toMatchObject({ kind: "refused", reason: "permission" });
    expect((o as any).message).not.toContain("fbtrace");
    expect((o as any).message).toMatch(/permission/i);
    expect(classifyPlatformDeleteResponse("FACEBOOK", 400, { error: { code: 200, message: "x" } })).toMatchObject({ reason: "permission" });
  });
});

describe("platformDeleteCapability", () => {
  it("unknown grant → nothing guessed", () => {
    expect(platformDeleteCapability("INSTAGRAM", null)).toEqual({ known: false, canDelete: null, missing: [] });
  });
  it("Instagram needs instagram_manage_contents; Facebook needs pages_manage_posts", () => {
    expect(platformDeleteCapability("INSTAGRAM", ["instagram_basic"])).toEqual({ known: true, canDelete: false, missing: ["instagram_manage_contents"] });
    expect(platformDeleteCapability("INSTAGRAM", ["instagram_basic", "instagram_manage_contents"]).canDelete).toBe(true);
    expect(platformDeleteCapability("FACEBOOK", ["pages_manage_posts"]).canDelete).toBe(true);
    expect(platformDeleteCapability("FACEBOOK", ["pages_show_list"]).missing).toEqual(["pages_manage_posts"]);
  });
  it("only Facebook and Instagram are supported", () => {
    expect(isPlatformDeletePlatform("FACEBOOK")).toBe(true);
    expect(isPlatformDeletePlatform("TIKTOK")).toBe(false);
    expect(isPlatformDeletePlatform("__proto__")).toBe(false);
  });
});

describe("provider deletePublishedPost", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Instagram sends DELETE /{media-id} and never throws", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, deleted_id: "179" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await new InstagramProvider().deletePublishedPost({ accessToken: "tok" }, "179");
    expect(out.kind).toBe("deleted");
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(init.method).toBe("DELETE");
    expect(String(url)).toMatch(/graph\.facebook\.com\/v\d+\.\d+\/179\?access_token=tok$/);
  });

  it("Instagram refuses a non-numeric id without any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await new InstagramProvider().deletePublishedPost({ accessToken: "tok" }, "../me/media");
    expect(out.kind).toBe("refused");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Instagram: a request that never completes → retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect((await new InstagramProvider().deletePublishedPost({ accessToken: "t" }, "1")).kind).toBe("retry");
  });

  it("Facebook deletes a composite post id and a bare video id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const fb = new FacebookProvider();
    expect((await fb.deletePublishedPost({ accessToken: "p" }, "111_222")).kind).toBe("deleted");
    expect((await fb.deletePublishedPost({ accessToken: "p" }, "333")).kind).toBe("deleted");
    const urls = fetchMock.mock.calls.map((c: any) => String(c[0]));
    expect(urls[0]).toContain("/111_222?access_token=p");
    expect(urls[1]).toContain("/333?access_token=p");
    expect(fetchMock.mock.calls.every((c: any) => c[1].method === "DELETE")).toBe(true);
  });

  it("Facebook: a throttled delete is NOT retried inside the provider (the worker owns retries)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 4, message: "limit" } }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await new FacebookProvider().deletePublishedPost({ accessToken: "p" }, "1_2");
    expect(out.kind).toBe("retry");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Facebook refuses an id that isn't a Graph object id", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await new FacebookProvider().deletePublishedPost({ accessToken: "p" }, "me/feed")).kind).toBe("refused");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
