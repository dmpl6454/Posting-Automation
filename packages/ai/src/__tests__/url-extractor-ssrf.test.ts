/**
 * Regression guard for F1: SSRF gate in extractUrlContent / fetchHtmlWithFallback.
 *
 * Before this fix, extractUrlContent only validated URL syntax. fetchHtmlWithFallback
 * then fetched the raw user-supplied URL with redirect:"follow" — allowing an
 * attacker to read 169.254.169.254/10.x/loopback content back through captions.
 *
 * After: extractUrlContent rejects any URL that fails isPublicPageUrl() before
 * any network call is made.
 */
import { describe, it, expect } from "vitest";
import { extractUrlContent } from "../utils/url-extractor";

describe("extractUrlContent — SSRF gate", () => {
  it("throws on cloud metadata IP (169.254.169.254)", async () => {
    await expect(extractUrlContent("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /not accessible|private/i,
    );
  });

  it("throws on RFC-1918 addresses (10.x)", async () => {
    await expect(extractUrlContent("http://10.0.0.1/secret")).rejects.toThrow(
      /not accessible|private/i,
    );
  });

  it("throws on localhost", async () => {
    await expect(extractUrlContent("http://localhost/admin")).rejects.toThrow(
      /not accessible|private/i,
    );
  });

  it("throws on loopback (127.0.0.1)", async () => {
    await expect(extractUrlContent("http://127.0.0.1/")).rejects.toThrow(
      /not accessible|private/i,
    );
  });

  it("throws on non-http scheme (file://)", async () => {
    await expect(extractUrlContent("file:///etc/passwd")).rejects.toThrow();
  });

  it("throws on plainly invalid URL", async () => {
    await expect(extractUrlContent("not-a-url")).rejects.toThrow(/invalid url/i);
  });
});
