/**
 * isPublicPageUrl / isPublicImageUrl guard every server-side fetch of a URL a
 * user typed (RSS, the repurpose URL extractor, the image proxy, NewsGrid
 * backgrounds, logos, avatars). They are STRING checks: their job is to reject
 * every internal address that can be written as a URL without any DNS.
 *
 * Measured 2026-10-01: they ACCEPTED http://[::ffff:127.0.0.1]/ (loopback) and
 * http://[::ffff:a9fe:a9fe]/ (the cloud metadata address), because the URL
 * parser rewrites mapped IPv4 into hex and the old regexes only knew the dotted
 * form. NAT64, 6to4, CGNAT and single-label Docker service names (minio, web,
 * redis) also passed.
 */
import { describe, it, expect, vi } from "vitest";
import { isPublicPageUrl, isPublicImageUrl } from "../utils/safe-fetch-url";

const INTERNAL = [
  "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
  "http://[::ffff:10.0.0.5]/",
  "http://[64:ff9b::a9fe:a9fe]/", // NAT64 → 169.254.169.254
  "http://[2002:a9fe:a9fe::]/", // 6to4 → 169.254.169.254
  "http://[::1]/",
  "http://[fd00::1]/",
  "http://[fe80::1]/",
  "http://100.100.100.200/", // CGNAT (Alibaba metadata)
  "http://0x7f000001/", // parsed as 127.0.0.1
  "http://2130706433/", // parsed as 127.0.0.1
  "http://minio:9000/postautomation-media/",
  "http://web:3000/api/health",
  "http://redis:6379/",
  "http://metadata.google.internal/",
  "http://printer.local/",
  "http://app.localhost/",
  "http://localhost./",
];

const PUBLIC = ["https://example.com/a", "https://news.bbc.co.uk/x", "http://93.184.216.34/", "https://[2606:4700::1111]/"];

describe("isPublicPageUrl", () => {
  it.each(INTERNAL)("rejects %s", (url) => {
    expect(isPublicPageUrl(url)).toBe(false);
  });
  it.each(PUBLIC)("accepts %s", (url) => {
    expect(isPublicPageUrl(url)).toBe(true);
  });
});

describe("isPublicImageUrl (https only)", () => {
  it.each(INTERNAL.map((u) => u.replace(/^http:/, "https:")))("rejects %s", (url) => {
    expect(isPublicImageUrl(url)).toBe(false);
  });
  it("accepts a public https host", () => {
    expect(isPublicImageUrl("https://cdn.example.com/logo.png")).toBe(true);
  });
});

describe("isAllowedImageUrl (S3 allow-list)", () => {
  it("still accepts the configured internal storage host, and only that", async () => {
    vi.resetModules();
    vi.stubEnv("S3_ENDPOINT", "http://minio:9000");
    vi.stubEnv("S3_PUBLIC_URL", "https://postautomation.co.in/media");
    try {
      const m = await import("../utils/safe-fetch-url");
      expect(m.isAllowedImageUrl("http://minio:9000/postautomation-media/a.png")).toBe(true);
      expect(m.isAllowedImageUrl("https://postautomation.co.in/media/a.png")).toBe(true);
      expect(m.isAllowedImageUrl("http://web:3000/a.png")).toBe(false);
      expect(m.isAllowedImageUrl("http://[::ffff:a9fe:a9fe]/a.png")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("rejects an internal IP literal even when it IS the allow-listed storage host", async () => {
    // The allow-list alone would admit it; only the private-address check stops it.
    vi.resetModules();
    vi.stubEnv("S3_ENDPOINT", "http://[::ffff:7f00:1]:9000");
    vi.stubEnv("S3_PUBLIC_URL", "http://127.0.0.1:9000/media");
    try {
      const m = await import("../utils/safe-fetch-url");
      expect(m.isAllowedImageUrl("http://[::ffff:7f00:1]:9000/postautomation-media/a.png")).toBe(false);
      expect(m.isAllowedImageUrl("http://127.0.0.1:9000/media/a.png")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
