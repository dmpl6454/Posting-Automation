import { describe, it, expect, beforeAll } from "vitest";

/**
 * Shared SSRF-safe image URL util (Task 1, Content Studio Phase 1).
 * The S3 allowlist is built from env at module load, so set it BEFORE
 * importing — every test lazily imports inside `load()`.
 */
beforeAll(() => {
  process.env.S3_PUBLIC_URL = "https://media.postautomation.co.in/postautomation-media";
});

describe("isAllowedImageUrl (shared SSRF guard)", () => {
  async function load() {
    return (await import("../utils/safe-fetch-url")).isAllowedImageUrl;
  }

  it("allows the configured S3 public host", async () => {
    const isAllowed = await load();
    expect(isAllowed("https://media.postautomation.co.in/postautomation-media/x.png")).toBe(true);
  });

  it("allows data:image/...;base64 URLs", async () => {
    const isAllowed = await load();
    expect(isAllowed("data:image/png;base64,AAAA")).toBe(true);
  });

  it("blocks an arbitrary external host (not allowlisted)", async () => {
    const isAllowed = await load();
    expect(isAllowed("https://evil.example.com/x.png")).toBe(false);
  });

  it("blocks loopback / private / link-local / metadata IPs and localhost", async () => {
    const isAllowed = await load();
    expect(isAllowed("http://127.0.0.1/x")).toBe(false);
    expect(isAllowed("http://10.0.0.5/x")).toBe(false);
    expect(isAllowed("http://192.168.1.1/x")).toBe(false);
    expect(isAllowed("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowed("http://[::1]/x")).toBe(false);
    expect(isAllowed("http://localhost/x")).toBe(false);
    expect(isAllowed("http://[fd00::1]/x")).toBe(false);
    expect(isAllowed("http://[::ffff:10.0.0.1]/x")).toBe(false);
  });

  it("blocks non-http(s) schemes", async () => {
    const isAllowed = await load();
    expect(isAllowed("file:///etc/passwd")).toBe(false);
    expect(isAllowed("gopher://x/")).toBe(false);
  });
});

describe("safeFetchImage", () => {
  async function load() {
    return (await import("../utils/safe-fetch-url")).safeFetchImage;
  }

  it("throws for a disallowed URL without fetching", async () => {
    const safeFetchImage = await load();
    await expect(safeFetchImage("https://evil.example.com/x.png")).rejects.toThrow();
  });

  it("throws for a private/loopback URL", async () => {
    const safeFetchImage = await load();
    await expect(safeFetchImage("http://169.254.169.254/latest/meta-data/")).rejects.toThrow();
  });
});
