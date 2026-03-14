import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock infrastructure ──────────────────────────────────────────────
// We mock the prompt templates so that .pipe(model).pipe(parser) returns
// a controllable chain with an invoke() we can spy on.
// This avoids needing real LangChain RunnableSequence internals.

const mockChainInvoke = vi.fn();

vi.mock("@langchain/core/prompts", () => {
  class MockChatPromptTemplate {
    pipe() {
      return {
        pipe() {
          return { invoke: mockChainInvoke };
        },
      };
    }
  }
  return {
    ChatPromptTemplate: {
      fromMessages: () => new MockChatPromptTemplate(),
    },
  };
});

vi.mock("@langchain/core/output_parsers", () => ({
  StringOutputParser: vi.fn().mockImplementation(() => ({})),
}));

// Mock the provider factory — verify getModel is called with correct provider
const mockGetModel = vi.fn().mockReturnValue({});
vi.mock("../providers/provider.factory", () => ({
  getModel: (...args: unknown[]) => mockGetModel(...args),
  isLangChainProvider: (provider: string) =>
    provider === "openai" || provider === "anthropic" || provider === "grok" || provider === "deepseek",
}));

// Import after mocking
import { generateContent } from "../chains/content-generation.chain";
import { suggestHashtags } from "../chains/hashtag-suggestion.chain";
import { optimizeContent } from "../chains/schedule-optimization.chain";
import {
  PLATFORM_CHAR_LIMITS,
  PLATFORM_TONES,
} from "../prompts/platform-specific.prompts";

describe("Content Generation Chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── generateContent() ─────────────────────────────────────────────

  describe("generateContent()", () => {
    it("should invoke the chain and return a string result", async () => {
      mockChainInvoke.mockResolvedValueOnce(
        "Check out our new product launch! #excited"
      );

      const result = await generateContent({
        provider: "openai",
        platform: "TWITTER",
        userPrompt: "Write a tweet about a product launch",
      });

      expect(result).toBe("Check out our new product launch! #excited");
    });

    it("should call getModel with the specified provider", async () => {
      mockChainInvoke.mockResolvedValueOnce("result");

      await generateContent({
        provider: "anthropic",
        platform: "LINKEDIN",
        userPrompt: "Write a LinkedIn post",
      });

      expect(mockGetModel).toHaveBeenCalledWith("anthropic");
    });

    it("should call getModel with openai provider", async () => {
      mockChainInvoke.mockResolvedValueOnce("result");

      await generateContent({
        provider: "openai",
        platform: "INSTAGRAM",
        userPrompt: "Write an IG caption",
      });

      expect(mockGetModel).toHaveBeenCalledWith("openai");
    });

    it("should pass platform-specific char limit from PLATFORM_CHAR_LIMITS", async () => {
      mockChainInvoke.mockResolvedValueOnce("tweet content");

      await generateContent({
        provider: "openai",
        platform: "TWITTER",
        userPrompt: "tweet",
      });

      const invokeArg = mockChainInvoke.mock.calls[0]?.[0] as Record<
        string,
        string
      >;
      expect(invokeArg.charLimit).toBe("280");
    });

    it("should use custom charLimit when provided", async () => {
      mockChainInvoke.mockResolvedValueOnce("short content");

      await generateContent({
        provider: "openai",
        platform: "TWITTER",
        userPrompt: "tweet",
        charLimit: 140,
      });

      const invokeArg = mockChainInvoke.mock.calls[0]?.[0] as Record<
        string,
        string
      >;
      expect(invokeArg.charLimit).toBe("140");
    });

    it("should default charLimit to 280 when platform is unknown", async () => {
      mockChainInvoke.mockResolvedValueOnce("content");

      await generateContent({
        provider: "openai",
        platform: "UNKNOWN_PLATFORM",
        userPrompt: "write something",
      });

      const invokeArg = mockChainInvoke.mock.calls[0]?.[0] as Record<
        string,
        string
      >;
      expect(invokeArg.charLimit).toBe("280");
    });

    it("should pass platform-specific tone from PLATFORM_TONES", async () => {
      mockChainInvoke.mockResolvedValueOnce("linkedin post");

      await generateContent({
        provider: "openai",
        platform: "LINKEDIN",
        userPrompt: "post",
      });

      const invokeArg = mockChainInvoke.mock.calls[0]?.[0] as Record<
        string,
        string
      >;
      expect(invokeArg.tone).toBe(PLATFORM_TONES["LINKEDIN"]);
    });

    it("should use custom tone when provided", async () => {
      mockChainInvoke.mockResolvedValueOnce("formal post");

      await generateContent({
        provider: "openai",
        platform: "TWITTER",
        userPrompt: "write",
        tone: "formal and authoritative",
      });

      const invokeArg = mockChainInvoke.mock.calls[0]?.[0] as Record<
        string,
        string
      >;
      expect(invokeArg.tone).toBe("formal and authoritative");
    });

    it("should propagate errors from the model", async () => {
      mockChainInvoke.mockRejectedValueOnce(new Error("Model API call failed"));

      await expect(
        generateContent({
          provider: "openai",
          platform: "TWITTER",
          userPrompt: "test",
        })
      ).rejects.toThrow("Model API call failed");
    });
  });

  // ── suggestHashtags() ──────────────────────────────────────────────

  describe("suggestHashtags()", () => {
    it("should return an array of hashtags from model output", async () => {
      mockChainInvoke.mockResolvedValueOnce(
        "#coding #typescript #webdev #programming #react"
      );

      const result = await suggestHashtags({
        content: "Just shipped a new TypeScript feature",
        platform: "TWITTER",
      });

      expect(result).toEqual([
        "#coding",
        "#typescript",
        "#webdev",
        "#programming",
        "#react",
      ]);
    });

    it("should filter out non-hashtag words from model output", async () => {
      mockChainInvoke.mockResolvedValueOnce(
        "#coding here are #typescript some #webdev hashtags"
      );

      const result = await suggestHashtags({
        content: "some content",
        platform: "INSTAGRAM",
      });

      expect(result).toEqual(["#coding", "#typescript", "#webdev"]);
    });

    it("should default provider to openai when not specified", async () => {
      mockChainInvoke.mockResolvedValueOnce("#test");

      await suggestHashtags({
        content: "content",
        platform: "TWITTER",
      });

      expect(mockGetModel).toHaveBeenCalledWith("openai");
    });

    it("should use the specified provider", async () => {
      mockChainInvoke.mockResolvedValueOnce("#test");

      await suggestHashtags({
        content: "content",
        platform: "TWITTER",
        provider: "anthropic",
      });

      expect(mockGetModel).toHaveBeenCalledWith("anthropic");
    });

    it("should return empty array when model returns no hashtags", async () => {
      mockChainInvoke.mockResolvedValueOnce("no hashtags here at all");

      const result = await suggestHashtags({
        content: "content",
        platform: "TWITTER",
      });

      expect(result).toEqual([]);
    });

    it("should propagate errors from the model", async () => {
      mockChainInvoke.mockRejectedValueOnce(new Error("Rate limit exceeded"));

      await expect(
        suggestHashtags({ content: "test", platform: "TWITTER" })
      ).rejects.toThrow("Rate limit exceeded");
    });
  });

  // ── optimizeContent() ──────────────────────────────────────────────

  describe("optimizeContent()", () => {
    it("should return optimized content string", async () => {
      mockChainInvoke.mockResolvedValueOnce(
        "Optimized: Check out our amazing new feature that will transform your workflow!"
      );

      const result = await optimizeContent({
        content: "We have a new feature",
        platform: "LINKEDIN",
        goal: "engagement",
      });

      expect(result).toBe(
        "Optimized: Check out our amazing new feature that will transform your workflow!"
      );
    });

    it("should default provider to openai when not specified", async () => {
      mockChainInvoke.mockResolvedValueOnce("optimized");

      await optimizeContent({
        content: "content",
        platform: "TWITTER",
        goal: "reach",
      });

      expect(mockGetModel).toHaveBeenCalledWith("openai");
    });

    it("should use the specified provider", async () => {
      mockChainInvoke.mockResolvedValueOnce("optimized");

      await optimizeContent({
        content: "content",
        platform: "TWITTER",
        goal: "engagement",
        provider: "anthropic",
      });

      expect(mockGetModel).toHaveBeenCalledWith("anthropic");
    });

    it("should propagate errors from the model", async () => {
      mockChainInvoke.mockRejectedValueOnce(new Error("Service unavailable"));

      await expect(
        optimizeContent({
          content: "test",
          platform: "TWITTER",
          goal: "clicks",
        })
      ).rejects.toThrow("Service unavailable");
    });
  });

  // ── Platform Constants ────────────────────────────────────────────

  describe("PLATFORM_CHAR_LIMITS", () => {
    it("should have Twitter limit of 280", () => {
      expect(PLATFORM_CHAR_LIMITS["TWITTER"]).toBe(280);
    });

    it("should have Instagram limit of 2200", () => {
      expect(PLATFORM_CHAR_LIMITS["INSTAGRAM"]).toBe(2200);
    });

    it("should have LinkedIn limit of 3000", () => {
      expect(PLATFORM_CHAR_LIMITS["LINKEDIN"]).toBe(3000);
    });

    it("should have defined limits for all major platforms", () => {
      const expectedPlatforms = [
        "TWITTER",
        "INSTAGRAM",
        "FACEBOOK",
        "LINKEDIN",
        "YOUTUBE",
        "TIKTOK",
        "REDDIT",
        "PINTEREST",
        "THREADS",
        "TELEGRAM",
        "DISCORD",
        "SLACK",
        "MASTODON",
        "BLUESKY",
        "MEDIUM",
        "DEVTO",
      ];
      for (const platform of expectedPlatforms) {
        expect(PLATFORM_CHAR_LIMITS[platform]).toBeDefined();
        expect(typeof PLATFORM_CHAR_LIMITS[platform]).toBe("number");
      }
    });
  });

  describe("PLATFORM_TONES", () => {
    it("should have a professional tone for LinkedIn", () => {
      expect(PLATFORM_TONES["LINKEDIN"]).toContain("professional");
    });

    it("should have defined tones for all major platforms", () => {
      const expectedPlatforms = [
        "TWITTER",
        "INSTAGRAM",
        "FACEBOOK",
        "LINKEDIN",
      ];
      for (const platform of expectedPlatforms) {
        expect(PLATFORM_TONES[platform]).toBeDefined();
        expect(typeof PLATFORM_TONES[platform]).toBe("string");
      }
    });
  });
});
