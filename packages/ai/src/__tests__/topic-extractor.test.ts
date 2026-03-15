import { describe, it, expect } from "vitest";
import { extractTopics, generateTitleHash } from "../tools/topic-extractor";

describe("Topic Extractor", () => {
  describe("extractTopics", () => {
    it("should extract tech topic from Google AI content", () => {
      const topics = extractTopics("Google launches new AI platform for developers");
      expect(topics).toContain("tech");
    });

    it("should extract business topic from market news", () => {
      const topics = extractTopics("Stock market hits all-time high as revenue grows");
      expect(topics).toContain("business");
    });

    it("should extract multiple topics when content spans categories", () => {
      const topics = extractTopics("Tech startup IPO raises funding on stock market");
      expect(topics).toContain("tech");
      expect(topics).toContain("business");
    });

    it("should return ['general'] for unclassifiable content", () => {
      const topics = extractTopics("A nice sunny day outside the window");
      expect(topics).toEqual(["general"]);
    });

    it("should extract topics from summary when title has no keywords", () => {
      const topics = extractTopics("Breaking update", "New vaccine approved by FDA for clinical trials");
      expect(topics).toContain("health");
    });

    it("should extract crypto topics", () => {
      const topics = extractTopics("Bitcoin price surges past $100k on blockchain excitement");
      expect(topics).toContain("crypto");
    });

    it("should extract politics topics", () => {
      const topics = extractTopics("Senate passes new legislation on climate policy");
      expect(topics).toContain("politics");
    });

    it("should extract entertainment topics", () => {
      const topics = extractTopics("New Netflix series breaks streaming records");
      expect(topics).toContain("entertainment");
    });
  });

  describe("generateTitleHash", () => {
    it("should produce the same hash for similar titles with different word order", () => {
      const hash1 = generateTitleHash("Google launches AI platform");
      const hash2 = generateTitleHash("AI platform launches Google");
      expect(hash1).toBe(hash2);
    });

    it("should produce the same hash regardless of case", () => {
      const hash1 = generateTitleHash("Google Launches AI");
      const hash2 = generateTitleHash("google launches ai");
      expect(hash1).toBe(hash2);
    });

    it("should produce the same hash ignoring punctuation", () => {
      const hash1 = generateTitleHash("Google launches AI!");
      const hash2 = generateTitleHash("Google launches AI");
      expect(hash1).toBe(hash2);
    });

    it("should ignore stop words", () => {
      const hash1 = generateTitleHash("The Google launches an AI platform");
      const hash2 = generateTitleHash("Google launches AI platform");
      expect(hash1).toBe(hash2);
    });

    it("should produce different hashes for genuinely different titles", () => {
      const hash1 = generateTitleHash("Google launches AI platform");
      const hash2 = generateTitleHash("Apple releases new iPhone model");
      expect(hash1).not.toBe(hash2);
    });

    it("should return a hex string", () => {
      const hash = generateTitleHash("Some title");
      expect(hash).toMatch(/^[a-f0-9]{32}$/);
    });
  });
});
