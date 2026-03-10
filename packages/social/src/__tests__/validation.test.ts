import { describe, it, expect } from "vitest";
import { getSocialProvider } from "../abstract/social.factory";
import { validateMediaForPlatform } from "../utils/media-validator";
import type { SocialPostPayload } from "../abstract/social.types";

describe("SocialProvider.validateContent", () => {
  describe("content length validation", () => {
    it("returns no errors when content is within maxContentLength", () => {
      const provider = getSocialProvider("TWITTER");
      const payload: SocialPostPayload = {
        content: "Hello, world!", // 13 chars, well under 280
      };

      const errors = provider.validateContent(payload);
      expect(errors).toHaveLength(0);
    });

    it("returns no errors when content is exactly at maxContentLength", () => {
      const provider = getSocialProvider("TWITTER");
      const payload: SocialPostPayload = {
        content: "a".repeat(280),
      };

      const errors = provider.validateContent(payload);
      expect(errors).toHaveLength(0);
    });

    it("returns an error when content exceeds maxContentLength", () => {
      const provider = getSocialProvider("TWITTER");
      const payload: SocialPostPayload = {
        content: "a".repeat(281),
      };

      const errors = provider.validateContent(payload);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("280");
      expect(errors[0]).toContain("Twitter / X");
    });

    it("validates content length for Bluesky (300 char limit)", () => {
      const provider = getSocialProvider("BLUESKY");
      const shortPayload: SocialPostPayload = { content: "Short post" };
      const longPayload: SocialPostPayload = { content: "x".repeat(301) };

      expect(provider.validateContent(shortPayload)).toHaveLength(0);
      expect(provider.validateContent(longPayload)).toHaveLength(1);
      expect(provider.validateContent(longPayload)[0]).toContain("300");
    });

    it("validates content length for LinkedIn (3000 char limit)", () => {
      const provider = getSocialProvider("LINKEDIN");
      const validPayload: SocialPostPayload = { content: "y".repeat(3000) };
      const invalidPayload: SocialPostPayload = { content: "y".repeat(3001) };

      expect(provider.validateContent(validPayload)).toHaveLength(0);
      expect(provider.validateContent(invalidPayload)).toHaveLength(1);
    });
  });

  describe("media count validation", () => {
    it("returns no errors when mediaUrls is under maxMediaCount", () => {
      const provider = getSocialProvider("TWITTER");
      const payload: SocialPostPayload = {
        content: "With images",
        mediaUrls: ["https://example.com/img1.jpg", "https://example.com/img2.jpg"],
      };

      const errors = provider.validateContent(payload);
      expect(errors).toHaveLength(0);
    });

    it("returns no errors when mediaUrls is exactly at maxMediaCount", () => {
      const provider = getSocialProvider("TWITTER"); // max 4
      const payload: SocialPostPayload = {
        content: "Four images",
        mediaUrls: [
          "https://example.com/1.jpg",
          "https://example.com/2.jpg",
          "https://example.com/3.jpg",
          "https://example.com/4.jpg",
        ],
      };

      const errors = provider.validateContent(payload);
      expect(errors).toHaveLength(0);
    });

    it("returns an error when mediaUrls exceeds maxMediaCount", () => {
      const provider = getSocialProvider("TWITTER"); // max 4
      const payload: SocialPostPayload = {
        content: "Too many images",
        mediaUrls: [
          "https://example.com/1.jpg",
          "https://example.com/2.jpg",
          "https://example.com/3.jpg",
          "https://example.com/4.jpg",
          "https://example.com/5.jpg",
        ],
      };

      const errors = provider.validateContent(payload);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("4");
      expect(errors[0]).toContain("Twitter / X");
    });

    it("returns no errors when mediaUrls is omitted", () => {
      const provider = getSocialProvider("TWITTER");
      const payload: SocialPostPayload = {
        content: "No media",
      };

      const errors = provider.validateContent(payload);
      expect(errors).toHaveLength(0);
    });

    it("can return both content length and media count errors simultaneously", () => {
      const provider = getSocialProvider("TWITTER");
      const payload: SocialPostPayload = {
        content: "a".repeat(281),
        mediaUrls: Array.from({ length: 5 }, (_, i) => `https://example.com/${i}.jpg`),
      };

      const errors = provider.validateContent(payload);
      expect(errors).toHaveLength(2);
    });
  });
});

describe("validateMediaForPlatform", () => {
  const twitterConstraints = getSocialProvider("TWITTER").constraints;
  const mediumConstraints = getSocialProvider("MEDIUM").constraints;

  it("returns no errors for valid media files", () => {
    const files = [
      { type: "image/jpeg", size: 1024 * 1024 }, // 1MB
      { type: "image/png", size: 2 * 1024 * 1024 }, // 2MB
    ];

    const errors = validateMediaForPlatform(files, twitterConstraints);
    expect(errors).toHaveLength(0);
  });

  it("returns an error when file count exceeds maxMediaCount", () => {
    const files = Array.from({ length: 5 }, () => ({
      type: "image/jpeg",
      size: 1024,
    }));

    const errors = validateMediaForPlatform(files, twitterConstraints);
    expect(errors.some((e) => e.includes("Max 4 files allowed"))).toBe(true);
  });

  it("returns an error for unsupported file types", () => {
    const files = [{ type: "application/pdf", size: 1024 }];

    const errors = validateMediaForPlatform(files, twitterConstraints);
    expect(errors.some((e) => e.includes("Unsupported file type: application/pdf"))).toBe(true);
  });

  it("returns an error when file size exceeds maxMediaSize", () => {
    // Twitter maxMediaSize is 5 * 1024 * 1024 (5MB)
    const files = [{ type: "image/jpeg", size: 6 * 1024 * 1024 }];

    const errors = validateMediaForPlatform(files, twitterConstraints);
    expect(errors.some((e) => e.includes("exceeds max size"))).toBe(true);
  });

  it("allows any number of files when maxMediaCount is 0 (Medium)", () => {
    // Medium has maxMediaCount: 0 and supportedMediaTypes: ["image/jpeg", "image/png", "image/gif"]
    // With maxMediaCount 0, sending even 1 file should trigger "Max 0 files allowed"
    const files = [{ type: "image/jpeg", size: 1024 }];

    const errors = validateMediaForPlatform(files, mediumConstraints);
    expect(errors.some((e) => e.includes("Max 0 files allowed"))).toBe(true);
  });

  it("returns no errors for an empty file list", () => {
    const errors = validateMediaForPlatform([], twitterConstraints);
    expect(errors).toHaveLength(0);
  });

  it("accumulates multiple errors for multiple invalid files", () => {
    const files = [
      { type: "application/pdf", size: 6 * 1024 * 1024 }, // wrong type AND too big
      { type: "text/plain", size: 1024 }, // wrong type
    ];

    const errors = validateMediaForPlatform(files, twitterConstraints);
    // Should have: unsupported file type for pdf, exceeds max size for pdf,
    // unsupported file type for text/plain
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});
