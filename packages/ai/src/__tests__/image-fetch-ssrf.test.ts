import { describe, it, expect, beforeAll } from "vitest";

/**
 * SSRF guard for the Super Agent's server-side image fetch (Gemini path).
 * The allowlist is built from S3 env at module load, so set it BEFORE importing.
 */
beforeAll(() => {
  process.env.S3_PUBLIC_URL = "https://media.postautomation.co.in/postautomation-media";
});

describe("__isAllowedImageUrl (SSRF guard)", () => {
  async function load() {
    const mod = await import("../chains/chat-agent.chain");
    return mod.__isAllowedImageUrl;
  }

  it("allows the configured S3 public host", async () => {
    const isAllowed = await load();
    expect(isAllowed("https://media.postautomation.co.in/postautomation-media/x.png")).toBe(true);
  });
  it("blocks an arbitrary external host (not allowlisted)", async () => {
    const isAllowed = await load();
    expect(isAllowed("https://evil.example.com/x.png")).toBe(false);
  });
  it("blocks loopback / private / link-local / metadata IPs", async () => {
    const isAllowed = await load();
    expect(isAllowed("http://127.0.0.1/x")).toBe(false);
    expect(isAllowed("http://10.0.0.5/x")).toBe(false);
    expect(isAllowed("http://192.168.1.1/x")).toBe(false);
    expect(isAllowed("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowed("http://[::1]/x")).toBe(false);
    expect(isAllowed("http://localhost/x")).toBe(false);
  });
  it("blocks non-http(s) schemes", async () => {
    const isAllowed = await load();
    expect(isAllowed("file:///etc/passwd")).toBe(false);
    expect(isAllowed("gopher://x/")).toBe(false);
  });
});
