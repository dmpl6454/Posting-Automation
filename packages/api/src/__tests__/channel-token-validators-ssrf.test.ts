/**
 * SSRF guard for the two token connectors that fetch a user-supplied host
 * server-side (security audit 2026-09-28): Mastodon (instance URL) and
 * WordPress (self-hosted site URL). `channel.connectWithToken` is reachable by
 * any org member.
 *
 * Three layers, each locked here:
 *   1. isPublicPageUrl — cheap hostname-string check (localhost, private IP
 *      literals, metadata) before anything else.
 *   2. Every address the hostname RESOLVES to must be public. The string check
 *      alone let single-label Docker service names (http://minio:9000,
 *      http://web:3000) and any domain pointed at a private IP through.
 *   3. Every fetch uses redirect: "manual" (a 3xx is a validation failure, so a
 *      public host cannot bounce us to an internal one) and a 10s timeout.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const lookupMock = vi.fn(async (..._a: any[]): Promise<Array<{ address: string; family: number }>> => []);
vi.mock("node:dns", () => {
  const promises = { lookup: (...a: any[]) => lookupMock(...a) };
  return { promises, default: { promises } };
});

import { validateAndBuildChannel } from "../lib/channel-token-validators";

const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
const mastodonOk = () => ({
  ok: true,
  status: 200,
  type: "basic",
  json: async () => ({ id: "1", display_name: "Me", username: "me", acct: "me@mastodon.social" }),
});
const redirect = (status = 302) => ({ ok: false, status, type: "basic", headers: new Headers({ location: "http://10.0.0.1/" }), json: async () => null });
const opaque = () => ({ ok: false, status: 0, type: "opaqueredirect", json: async () => null });

const wp = (siteUrl: string) =>
  validateAndBuildChannel("WORDPRESS", { siteUrl, username: "admin", appPassword: "abcd 1234 efgh 5678" });
const mastodon = (instance: string) => validateAndBuildChannel("MASTODON", { instance, accessToken: "tok" });

beforeEach(() => {
  fetchMock.mockReset();
  lookupMock.mockReset();
  lookupMock.mockResolvedValue(PUBLIC);
});

function expectGuardedFetches() {
  expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  for (const [, init] of fetchMock.mock.calls) {
    expect(init).toMatchObject({ redirect: "manual" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  }
}

describe("validateAndBuildChannel(MASTODON) — SSRF", () => {
  it.each(["https://localhost", "https://127.0.0.1", "https://169.254.169.254"])(
    "refuses instance %s without any lookup or request",
    async (instance) => {
      await expect(mastodon(instance)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(lookupMock).not.toHaveBeenCalled(); // isPublicPageUrl stays the first, cheap check
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("refuses a public-looking domain that resolves to a private address", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    await expect(mastodon("https://internal.example.com")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(lookupMock).toHaveBeenCalledWith("internal.example.com", expect.objectContaining({ all: true }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when any one of several resolved addresses is private", async () => {
    lookupMock.mockResolvedValueOnce([...PUBLIC, { address: "fd00:ec2::254", family: 6 }]);
    await expect(mastodon("https://mixed.example.com")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a name that does not resolve", async () => {
    lookupMock.mockRejectedValueOnce(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    await expect(mastodon("https://nope.example.com")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["302", redirect(302)],
    ["307", redirect(307)],
    ["opaqueredirect", opaque()],
  ])("treats a %s response as a validation failure, never following it", async (_label, res) => {
    fetchMock.mockResolvedValueOnce(res);
    await expect(mastodon("https://mastodon.social")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectGuardedFetches();
  });

  it("turns a timeout / network error into BAD_REQUEST instead of a 500", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    await expect(mastodon("https://mastodon.social")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("still validates a real public instance, with redirect: manual and a timeout", async () => {
    fetchMock.mockResolvedValueOnce(mastodonOk());
    const res = await mastodon("https://mastodon.social");
    expect(res.platformId).toBe("1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a redirect from /wp-json/wp/v2/users/me as a validation failure", async () => {
    fetchMock.mockResolvedValueOnce(redirect(301));
    await expect(wp("http://yourblog.com")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectGuardedFetches();
  });

  it("never follows a redirect from the best-effort /wp-json site-name lookup", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, type: "basic", json: async () => ({ id: 1, slug: "admin", avatar_urls: {} }) })
      .mockResolvedValueOnce(redirect(302));
    const res = await wp("https://yourblog.com");
    expect(res.name).toBe("yourblog.com"); // falls back to the hostname; the Location is never fetched
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectGuardedFetches();
  });

  it("still validates a real public site", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, type: "basic", json: async () => ({ id: 1, slug: "admin", avatar_urls: {} }) })
      .mockResolvedValueOnce({ ok: true, status: 200, type: "basic", json: async () => ({ name: "My Blog" }) });
    const res = await wp("https://yourblog.com");
    expect(res.name).toBe("My Blog");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectGuardedFetches();
  });
});
