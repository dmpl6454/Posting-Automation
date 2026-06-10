import { describe, it, expect, vi, beforeAll } from "vitest";

/**
 * SSRF guard for `extractDominantColor`, which launches Puppeteer and loads the
 * given image URL. The allowlist is built from S3 env at module load, so set it
 * BEFORE importing. We mock puppeteer so the test fails loudly if `launch` is
 * ever reached for a blocked URL — the guard must short-circuit before any
 * browser is launched.
 */
beforeAll(() => {
  process.env.S3_PUBLIC_URL = "https://media.postautomation.co.in/postautomation-media";
});

vi.mock("puppeteer", () => ({
  default: {
    launch: vi.fn(() => {
      throw new Error("puppeteer.launch must NOT be called for a blocked URL");
    }),
  },
}));

describe("extractDominantColor SSRF", () => {
  it("returns null for a blocked URL without launching a browser", async () => {
    const { extractDominantColor } = await import("../tools/news-image-generator");
    await expect(
      extractDominantColor("http://169.254.169.254/latest/meta-data/"),
    ).resolves.toBeNull();
  });
});
