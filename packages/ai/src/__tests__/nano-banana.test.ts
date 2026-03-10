import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Save original env and restore after each test
const originalEnv = { ...process.env };

// Stub fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// We import the module under test AFTER stubbing globals
import {
  generateImage,
  editImage,
  NANO_BANANA_MODELS,
  NANO_BANANA_ASPECT_RATIOS,
  NANO_BANANA_SIZES,
} from "../providers/nano-banana.provider";
import type {
  NanoBananaGenerateParams,
  NanoBananaEditParams,
} from "../providers/nano-banana.provider";

/** Helper to build a successful Gemini API response body */
function makeGeminiResponse(opts?: {
  imageBase64?: string;
  mimeType?: string;
  text?: string;
  noImage?: boolean;
  noCandidates?: boolean;
}) {
  if (opts?.noCandidates) {
    return { candidates: [] };
  }

  const parts: Record<string, unknown>[] = [];

  if (!opts?.noImage) {
    parts.push({
      inlineData: {
        data: opts?.imageBase64 ?? "base64encodedimage",
        mimeType: opts?.mimeType ?? "image/png",
      },
    });
  }

  if (opts?.text) {
    parts.push({ text: opts.text });
  }

  return {
    candidates: [
      {
        content: { parts },
      },
    ],
  };
}

/** Helper to create a mock Response */
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe("Nano Banana Provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_GEMINI_API_KEY = "test-gemini-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ── Constants ──────────────────────────────────────────────────────

  describe("NANO_BANANA_MODELS", () => {
    it("should expose NANO_BANANA_2 model", () => {
      expect(NANO_BANANA_MODELS.NANO_BANANA_2).toBe(
        "gemini-3.1-flash-image-preview"
      );
    });

    it("should expose NANO_BANANA_PRO model", () => {
      expect(NANO_BANANA_MODELS.NANO_BANANA_PRO).toBe(
        "gemini-3-pro-image-preview"
      );
    });

    it("should expose NANO_BANANA (classic) model", () => {
      expect(NANO_BANANA_MODELS.NANO_BANANA).toBe("gemini-2.5-flash-image");
    });

    it("should have exactly 3 model entries", () => {
      expect(Object.keys(NANO_BANANA_MODELS)).toHaveLength(3);
    });
  });

  describe("NANO_BANANA_ASPECT_RATIOS", () => {
    it("should contain standard aspect ratios", () => {
      expect(NANO_BANANA_ASPECT_RATIOS).toContain("1:1");
      expect(NANO_BANANA_ASPECT_RATIOS).toContain("16:9");
      expect(NANO_BANANA_ASPECT_RATIOS).toContain("9:16");
      expect(NANO_BANANA_ASPECT_RATIOS).toContain("4:3");
    });

    it("should have exactly 10 aspect ratios", () => {
      expect(NANO_BANANA_ASPECT_RATIOS).toHaveLength(10);
    });
  });

  describe("NANO_BANANA_SIZES", () => {
    it("should contain expected sizes", () => {
      expect(NANO_BANANA_SIZES).toContain("512");
      expect(NANO_BANANA_SIZES).toContain("1K");
      expect(NANO_BANANA_SIZES).toContain("2K");
      expect(NANO_BANANA_SIZES).toContain("4K");
    });

    it("should have exactly 4 sizes", () => {
      expect(NANO_BANANA_SIZES).toHaveLength(4);
    });
  });

  // ── generateImage ─────────────────────────────────────────────────

  describe("generateImage()", () => {
    it("should return image data on successful generation", async () => {
      const responseBody = makeGeminiResponse({
        imageBase64: "abc123",
        mimeType: "image/png",
      });
      mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

      const result = await generateImage({ prompt: "a cat on a skateboard" });

      expect(result.imageBase64).toBe("abc123");
      expect(result.mimeType).toBe("image/png");
    });

    it("should include optional text response when present", async () => {
      const responseBody = makeGeminiResponse({
        imageBase64: "imgdata",
        text: "Here is your image of a sunset",
      });
      mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

      const result = await generateImage({ prompt: "sunset" });

      expect(result.text).toBe("Here is your image of a sunset");
    });

    it("should use the default model when none is specified", async () => {
      const responseBody = makeGeminiResponse();
      mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

      await generateImage({ prompt: "test" });

      const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain("gemini-3.1-flash-image-preview");
    });

    it("should use a custom model when specified", async () => {
      const responseBody = makeGeminiResponse();
      mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

      await generateImage({
        prompt: "test",
        model: "gemini-3-pro-image-preview",
      });

      const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain("gemini-3-pro-image-preview");
    });

    it("should send aspect ratio and image size in the request body", async () => {
      const responseBody = makeGeminiResponse();
      mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

      await generateImage({
        prompt: "landscape",
        aspectRatio: "16:9",
        imageSize: "2K",
      });

      const calledBody = JSON.parse(
        mockFetch.mock.calls[0]?.[1]?.body as string
      );
      expect(calledBody.generationConfig.imageConfig.aspectRatio).toBe("16:9");
      expect(calledBody.generationConfig.imageConfig.imageSize).toBe("2K");
    });

    it("should default aspect ratio to 1:1 and image size to 1K", async () => {
      const responseBody = makeGeminiResponse();
      mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

      await generateImage({ prompt: "test" });

      const calledBody = JSON.parse(
        mockFetch.mock.calls[0]?.[1]?.body as string
      );
      expect(calledBody.generationConfig.imageConfig.aspectRatio).toBe("1:1");
      expect(calledBody.generationConfig.imageConfig.imageSize).toBe("1K");
    });

    it("should send the API key in the x-goog-api-key header", async () => {
      const responseBody = makeGeminiResponse();
      mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

      await generateImage({ prompt: "test" });

      const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<
        string,
        string
      >;
      expect(headers["x-goog-api-key"]).toBe("test-gemini-key");
    });

    it("should throw when the API returns an error status", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ error: "quota exceeded" }, 429)
      );

      await expect(generateImage({ prompt: "test" })).rejects.toThrow(
        /Nano Banana API error \(429\)/
      );
    });

    it("should throw when response has no candidates", async () => {
      const responseBody = makeGeminiResponse({ noCandidates: true });
      mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

      await expect(generateImage({ prompt: "test" })).rejects.toThrow(
        "No content in Nano Banana response"
      );
    });

    it("should throw when response has no image data", async () => {
      const responseBody = makeGeminiResponse({ noImage: true, text: "oops" });
      mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

      await expect(generateImage({ prompt: "test" })).rejects.toThrow(
        "No image data in Nano Banana response"
      );
    });

    it("should throw when GOOGLE_GEMINI_API_KEY is not set", async () => {
      delete process.env.GOOGLE_GEMINI_API_KEY;
      delete process.env.GOOGLE_AI_API_KEY;

      await expect(generateImage({ prompt: "test" })).rejects.toThrow(
        /GOOGLE_GEMINI_API_KEY or GOOGLE_AI_API_KEY environment variable is required/
      );
    });

    it("should fall back to GOOGLE_AI_API_KEY when GOOGLE_GEMINI_API_KEY is not set", async () => {
      delete process.env.GOOGLE_GEMINI_API_KEY;
      process.env.GOOGLE_AI_API_KEY = "fallback-key";

      const responseBody = makeGeminiResponse();
      mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

      await generateImage({ prompt: "test" });

      const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<
        string,
        string
      >;
      expect(headers["x-goog-api-key"]).toBe("fallback-key");
    });
  });

  // ── editImage ─────────────────────────────────────────────────────

  describe("editImage()", () => {
    it("should return edited image data on success", async () => {
      const responseBody = makeGeminiResponse({
        imageBase64: "editedimage",
        mimeType: "image/jpeg",
      });
      mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

      const result = await editImage({
        prompt: "make it blue",
        imageBase64: "originalimage",
      });

      expect(result.imageBase64).toBe("editedimage");
      expect(result.mimeType).toBe("image/jpeg");
    });

    it("should send the original image as inline_data in the request", async () => {
      const responseBody = makeGeminiResponse();
      mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

      await editImage({
        prompt: "resize",
        imageBase64: "origBase64",
        imageMimeType: "image/webp",
      });

      const calledBody = JSON.parse(
        mockFetch.mock.calls[0]?.[1]?.body as string
      );
      const parts = calledBody.contents[0].parts;
      expect(parts[0].text).toBe("resize");
      expect(parts[1].inline_data.data).toBe("origBase64");
      expect(parts[1].inline_data.mime_type).toBe("image/webp");
    });

    it("should default imageMimeType to image/jpeg", async () => {
      const responseBody = makeGeminiResponse();
      mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

      await editImage({
        prompt: "edit",
        imageBase64: "data",
      });

      const calledBody = JSON.parse(
        mockFetch.mock.calls[0]?.[1]?.body as string
      );
      const inlineData = calledBody.contents[0].parts[1].inline_data;
      expect(inlineData.mime_type).toBe("image/jpeg");
    });

    it("should throw when the edit API returns an error", async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ error: "bad request" }, 400)
      );

      await expect(
        editImage({ prompt: "edit", imageBase64: "data" })
      ).rejects.toThrow(/Nano Banana edit API error \(400\)/);
    });

    it("should use a custom model for editing", async () => {
      const responseBody = makeGeminiResponse();
      mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

      await editImage({
        prompt: "fix colors",
        imageBase64: "data",
        model: "gemini-2.5-flash-image",
      });

      const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain("gemini-2.5-flash-image");
    });
  });
});
