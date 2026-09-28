/**
 * validateMastodon / validateWordPress had NO SSRF guard at all — unlike
 * every other user-supplied-URL fetch in this codebase (security audit
 * 2026-09-28).
 *
 * `channel.connectWithToken` is reachable by any org member (orgProcedure,
 * no operator setup required). Both validators took a free-form "instance" /
 * "siteUrl" string from the connect dialog and fetched it server-side with
 * only a cosmetic format regex:
 *   - Mastodon's `^https:\/\/[\w.-]+\.[a-z]{2,}$` blocks bare IPs (digits
 *     don't match `[a-z]{2,}`) but happily matches an internal DNS name like
 *     `metadata.google.internal` or an attacker's own domain pointed at a
 *     private IP.
 *   - WordPress's `^https?:\/\/[\w.-]+` is looser still — `http://`, bare
 *     IPv4 literals, and `localhost` all match it directly, so
 *     `siteUrl: "http://169.254.169.254"` (cloud metadata) or
 *     `http://localhost:6379` (an internal service) passed straight through
 *     to a real `fetch()` with no format check stopping it at all.
 *
 * Fixed by running both through `isPublicPageUrl` (already used everywhere
 * else in this codebase for exactly this class of user-supplied-URL fetch —
 * see repurpose.router.ts's resolveLogoForOrg / news-image-generator.ts),
 * which rejects private-IP-literal and loopback/link-local/metadata
 * HOSTNAMES before any network call is made. It does NOT resolve DNS, so an
 * internal-only domain name (e.g. `metadata.google.internal`, or an
 * attacker's own domain pointed at a private IP) is not caught — that is a
 * pre-existing, codebase-wide limitation of every isPublicPageUrl /
 * isPublicImageUrl consumer, not something this fix claims to close.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { validateAndBuildChannel } from "../lib/channel-token-validators";

beforeEach(() => {
  fetchMock.mockReset();
});

describe("validateAndBuildChannel(MASTODON) — SSRF", () => {
  // isPublicPageUrl (like every other SSRF guard in this codebase) blocks
  // private-IP-literal and loopback/link-local HOSTNAMES, not arbitrary
  // internal-sounding DNS names — resolving a hostname and checking the
  // resolved IP (closing the DNS-rebinding class, e.g. a name that only
  // resolves to a private IP from inside a specific network) is a deeper,
  // codebase-wide gap shared by isPublicImageUrl/isPublicPageUrl everywhere
  // else they're used, and is out of scope for bringing these two
  // validators up to parity with that existing (already-imperfect) guard.
  const ssrfInstances = [
    "https://localhost",
    "https://127.0.0.1",
    "https://169.254.169.254", // wouldn't match the old format regex, kept as a sanity check
  ];

  it.each(ssrfInstances)("refuses instance %s without making any network request", async (instance) => {
    await expect(
      validateAndBuildChannel("MASTODON", { instance, accessToken: "tok" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still validates a real public instance", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "1", display_name: "Me", username: "me", acct: "me@mastodon.social" }),
    });
    const res = await validateAndBuildChannel("MASTODON", { instance: "https://mastodon.social", accessToken: "tok" });
    expect(res.platformId).toBe("1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("validateAndBuildChannel(WORDPRESS) — SSRF", () => {
  const ssrfSiteUrls = [
    "http://localhost",
    "http://127.0.0.1",
    "http://169.254.169.254", // cloud metadata — this ALONE used to pass the old regex
    "http://10.0.0.5",
    "http://192.168.1.1:8080",
  ];

  it.each(ssrfSiteUrls)("refuses siteUrl %s without making any network request", async (siteUrl) => {
    await expect(
      validateAndBuildChannel("WORDPRESS", { siteUrl, username: "admin", appPassword: "abcd 1234 efgh 5678" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still validates a real public site", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 1, slug: "admin", avatar_urls: {} }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ name: "My Blog" }) });
    const res = await validateAndBuildChannel("WORDPRESS", {
      siteUrl: "https://yourblog.com",
      username: "admin",
      appPassword: "abcd 1234 efgh 5678",
    });
    expect(res.name).toBe("My Blog");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
