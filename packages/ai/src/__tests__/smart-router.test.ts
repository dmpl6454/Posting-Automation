import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../providers/gemini.provider", () => ({
  callGemini: vi.fn(),
}));

import { routeProvider, ROUTING_RULES } from "../routing/smart-router";
import { callGemini } from "../providers/gemini.provider";
import type { AIProvider } from "../types";

const mockedCallGemini = vi.mocked(callGemini);

describe("Smart Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("keyword routing", () => {
    it("should route trending/news messages to grok", async () => {
      const result = await routeProvider("What's the latest trending news today?", {});
      expect(result).toBe("grok");
    });

    it("should route creative writing messages to anthropic", async () => {
      const result = await routeProvider("Write me a creative story about space exploration", {});
      expect(result).toBe("anthropic");
    });

    it("should route analytical messages to deepseek", async () => {
      const result = await routeProvider("Analyze and compare the data from our campaigns", {});
      expect(result).toBe("deepseek");
    });

    it("should route structured/planning messages to openai", async () => {
      const result = await routeProvider("Schedule and plan my content for next week", {});
      expect(result).toBe("openai");
    });

    it("should route visual/image messages to gemini", async () => {
      const result = await routeProvider("Create a visual design for our image post", {});
      expect(result).toBe("gemini");
    });

    it("should route to gemini when hasAttachments is true", async () => {
      const result = await routeProvider("Check this out", { hasAttachments: true });
      expect(result).toBe("gemini");
    });
  });

  describe("keyword overlap (compound queries)", () => {
    it("should fall through to LLM when keywords match multiple categories", async () => {
      mockedCallGemini.mockResolvedValueOnce("analytical");
      const result = await routeProvider(
        "Analyze and research the breaking trending news data",
        {}
      );
      expect(mockedCallGemini).toHaveBeenCalled();
      expect(result).toBe("deepseek");
    });
  });

  describe("thread continuity (sticky provider)", () => {
    it("should prefer lastProvider when no strong keyword signal", async () => {
      const result = await routeProvider("sounds good, go ahead", {
        lastProvider: "anthropic",
      });
      expect(result).toBe("anthropic");
      expect(mockedCallGemini).not.toHaveBeenCalled();
    });

    it("should override sticky provider when strong single-category keyword signal exists", async () => {
      const result = await routeProvider("Now analyze and summarize the research data", {
        lastProvider: "grok",
      });
      expect(result).toBe("deepseek");
    });

    it("should use LLM when sticky provider set and multiple keyword categories match", async () => {
      mockedCallGemini.mockResolvedValueOnce("trending");
      const result = await routeProvider(
        "Analyze and research the breaking trending news data",
        { lastProvider: "openai" }
      );
      expect(mockedCallGemini).toHaveBeenCalled();
      expect(result).toBe("grok");
    });
  });

  describe("agent niche mapping", () => {
    it("should use niche when no keyword match and no lastProvider", async () => {
      const result = await routeProvider("help me out", { agentNiche: "news" });
      expect(result).toBe("grok");
      expect(mockedCallGemini).not.toHaveBeenCalled();
    });

    it("should ignore niche when keywords match", async () => {
      const result = await routeProvider("Write me a creative brainstorm", {
        agentNiche: "news",
      });
      expect(result).toBe("anthropic");
    });
  });

  describe("LLM fallback", () => {
    it("should call Gemini Flash when no keyword or niche match", async () => {
      mockedCallGemini.mockResolvedValueOnce("creative");
      const result = await routeProvider("help me with something", {});
      expect(mockedCallGemini).toHaveBeenCalled();
      expect(result).toBe("anthropic");
    });

    it("should default to openai when LLM returns unknown category", async () => {
      mockedCallGemini.mockResolvedValueOnce("something_random");
      const result = await routeProvider("random message", {});
      expect(result).toBe("openai");
    });

    it("should default to openai when LLM call fails", async () => {
      mockedCallGemini.mockRejectedValueOnce(new Error("API timeout"));
      const result = await routeProvider("random message", {});
      expect(result).toBe("openai");
    });
  });

  describe("integration: route-style context", () => {
    it("should handle full context object as stream route would pass", async () => {
      const result = await routeProvider("Write me a creative brainstorm for content", {
        threadHistory: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
        hasAttachments: false,
        agentNiche: undefined,
        lastProvider: undefined,
      });
      expect(result).toBe("anthropic");
    });

    it("should handle empty context gracefully", async () => {
      mockedCallGemini.mockResolvedValueOnce("structured");
      const result = await routeProvider("do something", {});
      expect(result).toBe("openai"); // LLM returns "structured"
    });
  });
});
