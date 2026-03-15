import { describe, it, expect } from "vitest";
import {
  calculateRecencyScore,
  calculateSourceCredibility,
  calculateViralSignal,
  calculateNicheRelevance,
  calculateTrendScore,
} from "../tools/trend-scorer";

describe("Trend Scorer", () => {
  describe("calculateRecencyScore", () => {
    it("should return 100 for articles published less than 1 hour ago", () => {
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
      expect(calculateRecencyScore(thirtyMinAgo)).toBe(100);
    });

    it("should return 80 for articles published 1-3 hours ago", () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      expect(calculateRecencyScore(twoHoursAgo)).toBe(80);
    });

    it("should return 50 for articles published 3-6 hours ago", () => {
      const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
      expect(calculateRecencyScore(fourHoursAgo)).toBe(50);
    });

    it("should return 30 for articles published 6-12 hours ago", () => {
      const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
      expect(calculateRecencyScore(eightHoursAgo)).toBe(30);
    });

    it("should return 10 for articles published 12-24 hours ago", () => {
      const eighteenHoursAgo = new Date(Date.now() - 18 * 60 * 60 * 1000);
      expect(calculateRecencyScore(eighteenHoursAgo)).toBe(10);
    });

    it("should return 0 for articles published more than 24 hours ago", () => {
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      expect(calculateRecencyScore(twoDaysAgo)).toBe(0);
    });
  });

  describe("calculateSourceCredibility", () => {
    it("should return 95 for Reuters", () => {
      expect(calculateSourceCredibility("Reuters")).toBe(95);
    });

    it("should return 95 for AP News", () => {
      expect(calculateSourceCredibility("AP News")).toBe(95);
    });

    it("should return 80 for TechCrunch", () => {
      expect(calculateSourceCredibility("TechCrunch")).toBe(80);
    });

    it("should return 55 for Reddit sources (r/xxx)", () => {
      expect(calculateSourceCredibility("r/technology")).toBe(55);
    });

    it("should return 55 for sources containing 'reddit'", () => {
      expect(calculateSourceCredibility("reddit.com")).toBe(55);
    });

    it("should return 50 for unknown sources", () => {
      expect(calculateSourceCredibility("RandomBlog123")).toBe(50);
    });

    it("should match partial source names case-insensitively", () => {
      expect(calculateSourceCredibility("bbc news")).toBe(90);
    });
  });

  describe("calculateViralSignal", () => {
    it("should return 30 when viralSignal is undefined", () => {
      expect(calculateViralSignal(undefined)).toBe(30);
    });

    it("should return 100 for reddit posts with >10k upvotes", () => {
      expect(calculateViralSignal(15_000, "reddit")).toBe(100);
    });

    it("should return 60 for reddit posts with >1k upvotes", () => {
      expect(calculateViralSignal(2_000, "reddit")).toBe(60);
    });

    it("should return 100 for twitter posts with >100k likes", () => {
      expect(calculateViralSignal(150_000, "twitter")).toBe(100);
    });

    it("should return 30 for unrecognized source types", () => {
      expect(calculateViralSignal(50_000, "mastodon")).toBe(30);
    });
  });

  describe("calculateNicheRelevance", () => {
    it("should return 20 when itemTopics is empty", () => {
      expect(calculateNicheRelevance([], ["tech"])).toBe(20);
    });

    it("should return 20 when agentTopics is empty", () => {
      expect(calculateNicheRelevance(["tech"], [])).toBe(20);
    });

    it("should return >0 when topics overlap", () => {
      const score = calculateNicheRelevance(["tech", "science"], ["tech", "business"]);
      expect(score).toBeGreaterThan(0);
    });

    it("should return 100 for perfect overlap", () => {
      expect(calculateNicheRelevance(["tech"], ["tech"])).toBe(100);
    });

    it("should return 0 when no topics match", () => {
      expect(calculateNicheRelevance(["tech"], ["sports"])).toBe(0);
    });

    it("should be case-insensitive", () => {
      expect(calculateNicheRelevance(["Tech"], ["tech"])).toBe(100);
    });
  });

  describe("calculateTrendScore", () => {
    it("should return a score between 0 and 100", () => {
      const score = calculateTrendScore({
        publishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        sourceName: "Reuters",
        viralSignal: 5_000,
        sourceType: "reddit",
        itemTopics: ["tech"],
        agentTopics: ["tech"],
      });
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it("should produce a high score for recent, credible, relevant, viral content", () => {
      const score = calculateTrendScore({
        publishedAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
        sourceName: "Reuters",
        viralSignal: 200_000,
        sourceType: "twitter",
        itemTopics: ["tech"],
        agentTopics: ["tech"],
      });
      expect(score).toBeGreaterThanOrEqual(90);
    });

    it("should produce a low score for old, unknown, irrelevant content", () => {
      const score = calculateTrendScore({
        publishedAt: new Date(Date.now() - 48 * 60 * 60 * 1000), // 2 days ago
        sourceName: "UnknownBlog",
        itemTopics: ["sports"],
        agentTopics: ["tech"],
      });
      expect(score).toBeLessThanOrEqual(30);
    });
  });
});
