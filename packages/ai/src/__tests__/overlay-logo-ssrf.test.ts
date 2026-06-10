import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

/**
 * SSRF guard for `overlayLogoOnImage`, which renders a user-supplied logo URL
 * inside a headless browser via `<img src="${logoUrl}">` + `page.setContent`.
 * An internal/private host must NEVER end up in the rendered HTML (no server-
 * side egress to it); a public CDN logo MUST still render.
 *
 * We mock puppeteer to CAPTURE the HTML passed to `page.setContent` and to
 * return a dummy screenshot buffer, so no real browser launches.
 */
const setContentMock = vi.fn(async () => {});

vi.mock("puppeteer", () => ({
  default: {
    launch: vi.fn(async () => ({
      newPage: vi.fn(async () => ({
        setViewport: vi.fn(async () => {}),
        setContent: setContentMock,
        screenshot: vi.fn(async () => Buffer.from("dummy").toString("base64")),
        evaluate: vi.fn(async () => null),
      })),
      close: vi.fn(async () => {}),
    })),
  },
}));

beforeAll(() => {
  process.env.S3_PUBLIC_URL = "https://media.postautomation.co.in/postautomation-media";
});

beforeEach(() => {
  setContentMock.mockClear();
});

describe("overlayLogoOnImage SSRF", () => {
  function lastHtml(): string {
    const calls = setContentMock.mock.calls as unknown as Array<[string, ...unknown[]]>;
    const call = calls[calls.length - 1];
    return call?.[0] ?? "";
  }

  it("drops an internal/metadata logo URL — never renders it as an <img src>", async () => {
    const { overlayLogoOnImage } = await import("../tools/news-image-generator");
    await overlayLogoOnImage({
      imageBase64: "AAAA",
      mimeType: "image/png",
      width: 1080,
      height: 1350,
      logoUrl: "http://169.254.169.254/x",
      channelName: "Acme",
    });
    const html = lastHtml();
    expect(html).not.toContain("169.254.169.254");
    // graceful fallback: the initial-letter avatar is rendered instead of <img>
    expect(html).not.toContain("<img");
  });

  it("renders a public CDN logo URL as an <img src>", async () => {
    const { overlayLogoOnImage } = await import("../tools/news-image-generator");
    await overlayLogoOnImage({
      imageBase64: "AAAA",
      mimeType: "image/png",
      width: 1080,
      height: 1350,
      logoUrl: "https://cdn.example.com/logo.png",
      channelName: "Acme",
    });
    const html = lastHtml();
    expect(html).toContain("https://cdn.example.com/logo.png");
    expect(html).toContain("<img");
  });
});
