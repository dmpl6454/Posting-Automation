/**
 * SSRF guard for the two token connectors that contact a user-supplied host
 * server-side (security audit 2026-09-28): Mastodon (instance URL) and
 * WordPress (self-hosted site URL). `channel.connectWithToken` is reachable by
 * any org member.
 *
 * Layers, each locked here:
 *   1. isPublicPageUrl — cheap hostname-string check (localhost, private IP
 *      literals, metadata) before anything else.
 *   2. Every address the hostname RESOLVES to must be public. The string check
 *      alone let single-label Docker service names (http://minio:9000,
 *      http://web:3000) and any domain pointed at a private IP through.
 *   3. Every request goes through userHostFetch (2026-10-01), which connects
 *      only to the addresses it checked — so a DNS answer that flips after
 *      layer 2 (rebinding) is still refused — never follows a redirect, and has
 *      a deadline. Plain fetch() resolved the name a second time.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const hostFetch = vi.fn(async (..._a: any[]): Promise<Response> => new Response("{}"));
vi.mock("@postautomation/social/src/utils/user-host-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@postautomation/social/src/utils/user-host-fetch")>();
  return { ...actual, userHostFetch: (...a: any[]) => hostFetch(...a) };
});

// Mastodon/WordPress must never use plain fetch again.
const plainFetch = vi.fn(async () => {
  throw new Error("plain fetch() must not be used for a user-named server");
});
vi.stubGlobal("fetch", plainFetch);

const lookupMock = vi.fn(async (..._a: any[]): Promise<Array<{ address: string; family: number }>> => []);
vi.mock("node:dns", () => {
  const promises = { lookup: (...a: any[]) => lookupMock(...a) };
  return { promises, default: { promises } };
});

import { validateAndBuildChannel } from "../lib/channel-token-validators";
import { UserHostError } from "@postautomation/social/src/utils/user-host-fetch";

const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const mastodonOk = () => json({ id: "1", display_name: "Me", username: "me", acct: "me@mastodon.social" });
const redirect = (status: number) => new UserHostError("redirect", { status, requestSent: true });

const wp = (siteUrl: string) =>
  validateAndBuildChannel("WORDPRESS", { siteUrl, username: "admin", appPassword: "abcd 1234 efgh 5678" });
const mastodon = (instance: string) => validateAndBuildChannel("MASTODON", { instance, accessToken: "tok" });

beforeEach(() => {
  hostFetch.mockReset();
  plainFetch.mockClear();
  lookupMock.mockReset();
  lookupMock.mockResolvedValue(PUBLIC);
});

function expectGuardedFetches() {
  expect(hostFetch.mock.calls.length).toBeGreaterThan(0);
  for (const [, init] of hostFetch.mock.calls) expect(init.timeoutMs).toBe(10_000);
  expect(plainFetch).not.toHaveBeenCalled();
}

describe("validateAndBuildChannel(MASTODON) — SSRF", () => {
  it.each(["https://localhost", "https://127.0.0.1", "https://169.254.169.254"])(
    "refuses instance %s without any lookup or request",
    async (instance) => {
      await expect(mastodon(instance)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(lookupMock).not.toHaveBeenCalled(); // isPublicPageUrl stays the first, cheap check
      expect(hostFetch).not.toHaveBeenCalled();
    },
  );

  it("refuses a public-looking domain that resolves to a private address", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    await expect(mastodon("https://internal.example.com")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(lookupMock).toHaveBeenCalledWith("internal.example.com", expect.objectContaining({ all: true }));
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("refuses when any one of several resolved addresses is private", async () => {
    lookupMock.mockResolvedValueOnce([...PUBLIC, { address: "fd00:ec2::254", family: 6 }]);
    await expect(mastodon("https://mixed.example.com")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("refuses a name that does not resolve", async () => {
    lookupMock.mockRejectedValueOnce(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    await expect(mastodon("https://nope.example.com")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("refuses a name that passed the DNS check but resolves privately at connect time (rebinding)", async () => {
    hostFetch.mockRejectedValueOnce(new UserHostError("blocked"));
    await expect(mastodon("https://rebind.example.com")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("must be a public Mastodon instance"),
    });
  });

  it.each([301, 302, 307, 308])("treats an HTTP %s as a validation failure, never following it", async (status) => {
    hostFetch.mockRejectedValueOnce(redirect(status));
    await expect(mastodon("https://mastodon.social")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("redirects somewhere else"),
    });
    expect(hostFetch).toHaveBeenCalledTimes(1);
  });

  it("turns a timeout / network error into BAD_REQUEST instead of a 500", async () => {
    hostFetch.mockRejectedValueOnce(new UserHostError("transport", { code: "ETIMEDOUT", requestSent: true }));
    await expect(mastodon("https://mastodon.social")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("normalises the instance before it becomes part of the key (letter case, http, trailing slash)", async () => {
    // A differently-typed URL must update the same channel row, not create a second one.
    for (const typed of ["HTTPS://Mastodon.Social/", "http://mastodon.social", "https://mastodon.social."]) {
      hostFetch.mockResolvedValueOnce(mastodonOk());
      const res = await mastodon(typed);
      expect(res.platformId).toBe("https://mastodon.social#1");
      expect(res.metadata).toMatchObject({ instance: "https://mastodon.social" });
    }
  });

  it.each(["https://mastodon.social:8443", "https://mastodon.social/@me", "https://u:p@mastodon.social", "https://mastodon.social/?x=1"])(
    "refuses %s (port, path, login details or query)",
    async (instance) => {
      await expect(mastodon(instance)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(hostFetch).not.toHaveBeenCalled();
    },
  );

  it("still validates a real public instance, keyed by instance + account id", async () => {
    hostFetch.mockResolvedValueOnce(mastodonOk());
    const res = await mastodon("https://mastodon.social/");
    // The instance is part of the key: account ids are only unique per instance.
    expect(res.platformId).toBe("https://mastodon.social#1");
    expect(res.metadata).toMatchObject({ instance: "https://mastodon.social" });
    expect(hostFetch.mock.calls[0]![0]).toBe("https://mastodon.social/api/v1/accounts/verify_credentials");
    expectGuardedFetches();
  });
});

describe("validateAndBuildChannel(WORDPRESS) — SSRF", () => {
  it.each([
    "http://localhost",
    "http://127.0.0.1",
    "http://169.254.169.254", // cloud metadata — this ALONE used to pass the old regex
    "http://10.0.0.5",
    "http://192.168.1.1:8080",
  ])("refuses siteUrl %s without any request", async (siteUrl) => {
    await expect(wp(siteUrl)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["http://minio:9000", "172.18.0.3"],
    ["http://web:3000", "172.18.0.7"],
    ["http://redis:6379", "172.18.0.2"],
    ["https://evil.example.com", "127.0.0.1"],
    ["https://v6.example.com", "::ffff:169.254.169.254"],
  ])("refuses %s (resolves to %s) without any request", async (siteUrl, address) => {
    lookupMock.mockResolvedValueOnce([{ address, family: address.includes(":") ? 6 : 4 }]);
    await expect(wp(siteUrl)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://admin:secret@yourblog.com",
    "https://yourblog.com/?x=1",
    "https://yourblog.com/#top",
    "ftp://yourblog.com",
    "yourblog.com",
  ])("refuses %s (login details, query, fragment or no http(s))", async (siteUrl) => {
    await expect(wp(siteUrl)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it("treats a redirect from /wp-json/wp/v2/users/me as a validation failure", async () => {
    hostFetch.mockRejectedValueOnce(redirect(301));
    await expect(wp("http://yourblog.com")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("redirects somewhere else"),
    });
    expect(hostFetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a site that resolves privately at connect time (rebinding)", async () => {
    hostFetch.mockRejectedValueOnce(new UserHostError("blocked"));
    await expect(wp("https://rebind.example.com")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("must be a public WordPress site"),
    });
  });

  it("never follows a redirect from the best-effort /wp-json site-name lookup", async () => {
    hostFetch.mockResolvedValueOnce(json({ id: 1, slug: "admin", avatar_urls: {} })).mockRejectedValueOnce(redirect(302));
    const res = await wp("https://yourblog.com");
    expect(res.name).toBe("yourblog.com"); // falls back to the hostname; the Location is never fetched
    expect(hostFetch).toHaveBeenCalledTimes(2);
    expectGuardedFetches();
  });

  it("still validates a real public site, storing a normalised address", async () => {
    hostFetch
      .mockResolvedValueOnce(json({ id: 1, slug: "admin", avatar_urls: {} }))
      .mockResolvedValueOnce(json({ name: "My Blog" }));
    const res = await wp("HTTPS://YourBlog.com/news/");
    expect(res.name).toBe("My Blog");
    expect(res.metadata).toMatchObject({ siteUrl: "https://yourblog.com/news", kind: "self-hosted" });
    expect(res.platformId).toBe("https://yourblog.com/news#1");
    expect(hostFetch.mock.calls[0]![0]).toBe("https://yourblog.com/news/wp-json/wp/v2/users/me?context=edit");
    // Only the name: a plugin-heavy site's full REST index can exceed the cap.
    expect(hostFetch.mock.calls[1]![0]).toBe("https://yourblog.com/news/wp-json/?_fields=name");
    expectGuardedFetches();
  });
});
