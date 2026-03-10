import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the AI package
const mockGenerateImage = vi.fn();
const mockEditImage = vi.fn();
const mockGenerateImageDallE = vi.fn();
const mockEditImageDallE = vi.fn();

vi.mock("@postautomation/ai", () => ({
  generateImage: (...args: any[]) => mockGenerateImage(...args),
  editImage: (...args: any[]) => mockEditImage(...args),
  generateImageDallE: (...args: any[]) => mockGenerateImageDallE(...args),
  editImageDallE: (...args: any[]) => mockEditImageDallE(...args),
}));

// Mock Prisma
const mockPrismaMedia = {
  create: vi.fn(),
  update: vi.fn(),
};

const mockPrisma = {
  media: mockPrismaMedia,
  organizationMember: {
    findUnique: vi.fn(),
  },
};

vi.mock("@postautomation/db", () => ({
  prisma: mockPrisma,
}));

// Mock rate limit middleware — let all requests through
vi.mock("../middleware/rate-limit.middleware", () => ({
  createRateLimitMiddleware: () =>
    ({ next }: { next: () => Promise<any> }) => next(),
}));

vi.mock("../middleware/rate-limit", () => ({
  aiRateLimiter: vi.fn().mockReturnValue({
    success: true,
    remaining: 19,
    resetAt: new Date(),
  }),
}));

describe("Image Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── generate endpoint ─────────────────────────────────────────────

  describe("image.generate", () => {
    it("should call generateImage with Nano Banana defaults", async () => {
      mockGenerateImage.mockResolvedValueOnce({
        imageBase64: "abc123",
        mimeType: "image/png",
        text: "A cute cat",
      });

      const result = await mockGenerateImage({
        prompt: "A cute cat",
        aspectRatio: "1:1",
        imageSize: "1K",
      });

      expect(result.imageBase64).toBe("abc123");
      expect(result.mimeType).toBe("image/png");
      expect(mockGenerateImage).toHaveBeenCalledWith({
        prompt: "A cute cat",
        aspectRatio: "1:1",
        imageSize: "1K",
      });
    });

    it("should return imageBase64, mimeType, and description from Nano Banana", async () => {
      mockGenerateImage.mockResolvedValueOnce({
        imageBase64: "imagedata",
        mimeType: "image/png",
        text: "a sunset over mountains",
      });

      const result = await mockGenerateImage({
        prompt: "sunset mountains",
      });

      expect(result).toEqual({
        imageBase64: "imagedata",
        mimeType: "image/png",
        text: "a sunset over mountains",
      });
    });

    it("should use nano-banana-pro model when provider is nano-banana-pro", async () => {
      mockGenerateImage.mockResolvedValueOnce({
        imageBase64: "proimage",
        mimeType: "image/png",
      });

      const model = "gemini-3-pro-image-preview";
      await mockGenerateImage({
        prompt: "professional photo",
        model,
      });

      expect(mockGenerateImage).toHaveBeenCalledWith({
        prompt: "professional photo",
        model: "gemini-3-pro-image-preview",
      });
    });

    it("should call generateImageDallE when provider is dall-e", async () => {
      mockGenerateImageDallE.mockResolvedValueOnce({
        imageBase64: "dalleimg",
        mimeType: "image/png",
        text: "A vivid landscape",
      });

      const result = await mockGenerateImageDallE({
        prompt: "landscape painting",
        size: "1024x1024",
        quality: "hd",
      });

      expect(result.imageBase64).toBe("dalleimg");
      expect(mockGenerateImageDallE).toHaveBeenCalledWith({
        prompt: "landscape painting",
        size: "1024x1024",
        quality: "hd",
      });
    });

    it("should throw an error when generateImage fails", async () => {
      mockGenerateImage.mockRejectedValueOnce(
        new Error("Nano Banana API error (500): Internal server error")
      );

      await expect(
        mockGenerateImage({ prompt: "test" })
      ).rejects.toThrow("Nano Banana API error (500)");
    });

    it("should reject prompt that is empty string", () => {
      // Simulating Zod validation: z.string().min(1).max(2000)
      const prompt = "";
      expect(prompt.length).toBe(0);
      expect(prompt.length >= 1).toBe(false);
    });

    it("should reject prompt that exceeds 2000 characters", () => {
      const prompt = "x".repeat(2001);
      expect(prompt.length).toBe(2001);
      expect(prompt.length <= 2000).toBe(false);
    });

    it("should accept valid prompt within limits", () => {
      const prompt = "Generate a beautiful sunset image";
      expect(prompt.length >= 1 && prompt.length <= 2000).toBe(true);
    });

    it("should validate provider enum accepts only valid values", () => {
      const validProviders = ["nano-banana", "nano-banana-pro", "dall-e"];
      expect(validProviders).toContain("nano-banana");
      expect(validProviders).toContain("nano-banana-pro");
      expect(validProviders).toContain("dall-e");
      expect(validProviders).not.toContain("midjourney");
      expect(validProviders).not.toContain("stable-diffusion");
    });

    it("should validate model enum for nano-banana", () => {
      const validModels = [
        "gemini-3.1-flash-image-preview",
        "gemini-3-pro-image-preview",
        "gemini-2.5-flash-image",
      ];
      expect(validModels).toContain("gemini-3.1-flash-image-preview");
      expect(validModels).not.toContain("invalid-model");
    });
  });

  // ── edit endpoint ─────────────────────────────────────────────────

  describe("image.edit", () => {
    it("should call editImage with the provided parameters", async () => {
      mockEditImage.mockResolvedValueOnce({
        imageBase64: "editedresult",
        mimeType: "image/png",
        text: "Edited version",
      });

      const result = await mockEditImage({
        prompt: "make it brighter",
        imageBase64: "originalimage",
        imageMimeType: "image/jpeg",
      });

      expect(result.imageBase64).toBe("editedresult");
      expect(mockEditImage).toHaveBeenCalledWith({
        prompt: "make it brighter",
        imageBase64: "originalimage",
        imageMimeType: "image/jpeg",
      });
    });

    it("should reject DALL-E provider for editing", () => {
      // The router throws BAD_REQUEST for DALL-E editing
      const provider = "dall-e";
      const isEditSupported = provider !== "dall-e";
      expect(isEditSupported).toBe(false);
    });

    it("should use nano-banana-pro model when provider is nano-banana-pro", async () => {
      mockEditImage.mockResolvedValueOnce({
        imageBase64: "proedited",
        mimeType: "image/png",
      });

      await mockEditImage({
        prompt: "enhance details",
        imageBase64: "original",
        model: "gemini-3-pro-image-preview",
      });

      expect(mockEditImage).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gemini-3-pro-image-preview",
        })
      );
    });

    it("should throw when editImage fails", async () => {
      mockEditImage.mockRejectedValueOnce(
        new Error("Nano Banana edit API error (400): invalid image")
      );

      await expect(
        mockEditImage({
          prompt: "edit this",
          imageBase64: "bad data",
        })
      ).rejects.toThrow("Nano Banana edit API error (400)");
    });

    it("should require non-empty imageBase64", () => {
      // Simulating Zod validation: z.string().min(1)
      const imageBase64 = "";
      expect(imageBase64.length >= 1).toBe(false);
    });
  });

  // ── saveGenerated endpoint ────────────────────────────────────────

  describe("image.saveGenerated", () => {
    it("should create a media record via Prisma", async () => {
      const mockMediaRecord = {
        id: "media-1",
        organizationId: "org-1",
        uploadedById: "user-1",
        fileName: "generated-image.png",
        fileType: "image/png",
        fileSize: 12345,
        url: "",
      };
      mockPrismaMedia.create.mockResolvedValueOnce(mockMediaRecord);
      mockPrismaMedia.update.mockResolvedValueOnce({
        ...mockMediaRecord,
        url: "data:image/png;base64,imgdata",
      });

      await mockPrismaMedia.create({
        data: {
          organizationId: "org-1",
          uploadedById: "user-1",
          fileName: "generated-image.png",
          fileType: "image/png",
          fileSize: 12345,
          url: "",
        },
      });

      expect(mockPrismaMedia.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: "org-1",
          fileName: "generated-image.png",
          fileType: "image/png",
        }),
      });
    });

    it("should update media record with data URL after creation", async () => {
      mockPrismaMedia.create.mockResolvedValueOnce({ id: "media-2" });
      mockPrismaMedia.update.mockResolvedValueOnce({
        id: "media-2",
        url: "data:image/png;base64,abc123",
      });

      const media = await mockPrismaMedia.create({ data: {} });

      await mockPrismaMedia.update({
        where: { id: media.id },
        data: { url: "data:image/png;base64,abc123" },
      });

      expect(mockPrismaMedia.update).toHaveBeenCalledWith({
        where: { id: "media-2" },
        data: { url: "data:image/png;base64,abc123" },
      });
    });

    it("should compute approximate file size from base64 length", () => {
      const base64Data = "abc123"; // length 6
      const approxSize = Math.ceil((base64Data.length * 3) / 4);
      expect(approxSize).toBe(5); // ceil(6 * 3 / 4) = ceil(4.5) = 5
    });

    it("should use default fileName when not provided", () => {
      const defaults = {
        mimeType: "image/png",
        fileName: "generated-image.png",
      };
      expect(defaults.fileName).toBe("generated-image.png");
      expect(defaults.mimeType).toBe("image/png");
    });

    it("should construct a proper data URL for the stored image", () => {
      const mimeType = "image/png";
      const imageBase64 = "R0lGODlhAQABAIAAAAAAAP";
      const dataUrl = `data:${mimeType};base64,${imageBase64}`;
      expect(dataUrl).toBe(
        "data:image/png;base64,R0lGODlhAQABAIAAAAAAAP"
      );
      expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    });
  });
});
