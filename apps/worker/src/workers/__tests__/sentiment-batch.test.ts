import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  scoreMentionsBatch,
  buildBatchSentimentPrompt,
  parseBatchSentimentResponse,
} from "../sentiment-analysis.worker";

const items = [
  { mentionId: "m0", content: 'Loving the new "drop" 🔥' },
  { mentionId: "m1", content: "worst service ever\nnever again" },
  { mentionId: "m2", content: "it arrived" },
];

describe("buildBatchSentimentPrompt", () => {
  it("numbers every mention and JSON-quotes the text so quotes/newlines cannot break the list", () => {
    const prompt = buildBatchSentimentPrompt(items);
    expect(prompt).toContain('0: "Loving the new \\"drop\\" 🔥"');
    expect(prompt).toContain('1: "worst service ever\\nnever again"');
    expect(prompt).toContain('2: "it arrived"');
    expect(prompt).toMatch(/exactly one object per text/);
  });
});

describe("parseBatchSentimentResponse", () => {
  it("matches verdicts by their i field, tolerates markdown fences, clamps scores", () => {
    const raw = '```json\n[{"i":2,"sentiment":"NEUTRAL","score":0},{"i":0,"sentiment":"POSITIVE","score":1.7},{"i":1,"sentiment":"NEGATIVE","score":-0.9}]\n```';
    const v = parseBatchSentimentResponse(raw, 3);
    expect(v.get(0)).toEqual({ sentiment: "POSITIVE", score: 1 });
    expect(v.get(1)).toEqual({ sentiment: "NEGATIVE", score: -0.9 });
    expect(v.get(2)).toEqual({ sentiment: "NEUTRAL", score: 0 });
  });
  it("falls back to array position when i is missing, ignores out-of-range and duplicate i, unknown sentiment ⇒ NEUTRAL", () => {
    const raw = '[{"sentiment":"MIXED","score":0.1},{"sentiment":"GREAT","score":"x"},{"i":9,"sentiment":"POSITIVE","score":1},{"i":0,"sentiment":"NEGATIVE","score":-1}]';
    const v = parseBatchSentimentResponse(raw, 3);
    expect(v.get(0)).toEqual({ sentiment: "MIXED", score: 0.1 });
    expect(v.get(1)).toEqual({ sentiment: "NEUTRAL", score: 0 });
    expect(v.has(9)).toBe(false);
    expect(v.size).toBe(2);
  });
  it("returns an empty map for non-JSON", () => {
    expect(parseBatchSentimentResponse("Sorry, I cannot help with that.", 3).size).toBe(0);
    expect(parseBatchSentimentResponse("[not json", 3).size).toBe(0);
  });
});

describe("scoreMentionsBatch", () => {
  let updateMention: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    updateMention = vi.fn().mockResolvedValue(undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("ONE model call scores the whole batch and writes each verdict", async () => {
    const generateContentWithFallback = vi.fn().mockResolvedValue(
      '[{"i":0,"sentiment":"POSITIVE","score":0.8},{"i":1,"sentiment":"NEGATIVE","score":-0.7},{"i":2,"sentiment":"NEUTRAL","score":0}]',
    );
    const r = await scoreMentionsBatch(items, { generateContentWithFallback, updateMention, providersAttempted: ["anthropic", "openai"] });
    expect(generateContentWithFallback).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ scored: 3, defaulted: 0 });
    expect(updateMention).toHaveBeenCalledWith("m0", "POSITIVE", 0.8);
    expect(updateMention).toHaveBeenCalledWith("m1", "NEGATIVE", -0.7);
    expect(updateMention).toHaveBeenCalledWith("m2", "NEUTRAL", 0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("a mention the model skipped persists NEUTRAL/0 with a warn, the rest keep their verdicts", async () => {
    const generateContentWithFallback = vi.fn().mockResolvedValue('[{"i":0,"sentiment":"POSITIVE","score":0.5}]');
    const r = await scoreMentionsBatch(items, { generateContentWithFallback, updateMention, providersAttempted: ["anthropic"] });
    expect(r).toEqual({ scored: 1, defaulted: 2 });
    expect(updateMention).toHaveBeenCalledWith("m1", "NEUTRAL", 0);
    expect(updateMention).toHaveBeenCalledWith("m2", "NEUTRAL", 0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("every provider failing ⇒ NEUTRAL/0 for all, one error line naming the providers, error flag set", async () => {
    const generateContentWithFallback = vi.fn().mockRejectedValue(new Error("429 insufficient_quota"));
    const r = await scoreMentionsBatch(items, { generateContentWithFallback, updateMention, providersAttempted: ["anthropic", "openai"] });
    expect(r).toEqual({ scored: 0, defaulted: 3, error: true });
    expect(updateMention).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]![0])).toContain("anthropic, openai");
  });

  it("a one-item batch takes the single-mention path (same prompt shape as before)", async () => {
    const generateContentWithFallback = vi.fn().mockResolvedValue('{"sentiment":"POSITIVE","score":0.9}');
    const r = await scoreMentionsBatch([items[0]!], { generateContentWithFallback, updateMention, providersAttempted: ["anthropic"] });
    expect(r).toEqual({ scored: 1, defaulted: 0 });
    expect(String(generateContentWithFallback.mock.calls[0]![0])).toContain("Analyze the sentiment of this text");
  });

  it("an empty batch does nothing", async () => {
    const generateContentWithFallback = vi.fn();
    expect(await scoreMentionsBatch([], { generateContentWithFallback, updateMention, providersAttempted: [] })).toEqual({ scored: 0, defaulted: 0 });
    expect(generateContentWithFallback).not.toHaveBeenCalled();
  });
});
