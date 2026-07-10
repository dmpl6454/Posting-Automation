/**
 * SL-04 (light scope): sentiment-analysis.worker used to call a single
 * hardcoded provider ("anthropic"). ANY failure (missing key, 401, rate
 * limit, malformed AI JSON) fell into the generic catch block, which wrote
 * NEUTRAL/0 — indistinguishable from a real AI-determined neutral verdict.
 *
 * Fix: route the AI call through the shared withTextProviderFallback helper
 * (from @postautomation/ai) so a single provider's absence/failure doesn't
 * immediately zero out every mention's sentiment, and log a clearly distinct,
 * greppable message naming the providers attempted when EVERY provider in
 * the chain fails.
 *
 * scoreMentionSentiment takes its AI-call + DB-update as injected deps so
 * this test doesn't need to mock @postautomation/ai / @postautomation/db
 * module resolution for the pure-scoring-logic cases below.
 *
 * NOTE on coverage boundary: createSentimentAnalysisWorker's inner closure
 * (which actually constructs withTextProviderFallback("anthropic", ...) and
 * wires its onFallback callback to console.warn) is NOT exercised by an
 * automated test here — doing so would require either mocking
 * @postautomation/ai's module resolution or instantiating a real BullMQ
 * Worker (this repo's other worker tests don't do either; they all test
 * extracted/injectable functions, same pattern used here). That closure is
 * intentionally kept thin (glue only: build the chain, call the two library
 * functions, forward results into scoreMentionSentiment) and is verified by
 * code trace + tsc, not by a test that fakes the exact log strings the real
 * onFallback callback would produce. The case below instead calls the REAL
 * withTextProviderFallback + buildTextProviderChain library functions
 * directly (no mocking needed — they're pure/dependency-free) to prove the
 * actual fallback semantics scoreMentionSentiment relies on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withTextProviderFallback, buildTextProviderChain } from "@postautomation/ai";
import { scoreMentionSentiment } from "../sentiment-analysis.worker";

describe("scoreMentionSentiment", () => {
  let updateMention: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    updateMention = vi.fn().mockResolvedValue(undefined);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // buildTextProviderChain only includes a provider whose API key is
    // configured in env — pin both so the chain deterministically resolves
    // to ["anthropic", "openai"] regardless of the local/CI environment.
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-key";
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("scores sentiment normally when the AI call succeeds (no failure log)", async () => {
    const generateContentWithFallback = vi.fn().mockResolvedValue(
      JSON.stringify({ sentiment: "POSITIVE", score: 0.8 }),
    );

    const result = await scoreMentionSentiment("mention-1", "great news!", {
      generateContentWithFallback,
      updateMention,
      providersAttempted: ["anthropic", "openai"],
    });

    expect(result).toEqual({ mentionId: "mention-1", sentiment: "POSITIVE", score: 0.8 });
    expect(updateMention).toHaveBeenCalledWith("mention-1", "POSITIVE", 0.8);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("real withTextProviderFallback: first provider fails, second succeeds, onFallback fires, no error log", async () => {
    // Exercises the REAL library function (no mocking) with a fake per-provider
    // fn that fails for the first provider in the chain and succeeds for the
    // next — proving scoreMentionSentiment's success path is compatible with
    // withTextProviderFallback's actual retry-then-succeed behavior, and that
    // an intermediate hop logs via onFallback/console.warn, not console.error.
    const chain = buildTextProviderChain("anthropic");
    expect(chain[0]).toBe("anthropic"); // documents the actual (reviewed) ordering

    const attempts: string[] = [];
    const generateContentWithFallback = (_prompt: string) =>
      withTextProviderFallback(
        "anthropic",
        async (provider) => {
          attempts.push(provider);
          if (provider === "anthropic") throw new Error("missing key");
          return JSON.stringify({ sentiment: "NEGATIVE", score: -0.6 });
        },
        (failed, next, e) =>
          console.warn(
            `[SentimentAnalysis] Provider ${failed} failed (${e instanceof Error ? e.message.slice(0, 80) : e}), trying ${next}`,
          ),
      );

    const result = await scoreMentionSentiment("mention-2", "terrible experience", {
      generateContentWithFallback,
      updateMention,
      providersAttempted: chain,
    });

    expect(attempts).toEqual(["anthropic", "openai"]);
    expect(result).toEqual({ mentionId: "mention-2", sentiment: "NEGATIVE", score: -0.6 });
    expect(updateMention).toHaveBeenCalledWith("mention-2", "NEGATIVE", -0.6);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Provider anthropic failed"),
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("logs a distinct failure message naming attempted providers and persists NEUTRAL/0 when ALL providers fail", async () => {
    const generateContentWithFallback = vi.fn().mockRejectedValue(new Error("all providers exhausted"));

    const result = await scoreMentionSentiment("mention-3", "some content", {
      generateContentWithFallback,
      updateMention,
      providersAttempted: ["anthropic", "openai"],
    });

    expect(result).toEqual({ mentionId: "mention-3", sentiment: "NEUTRAL", score: 0, error: true });
    expect(updateMention).toHaveBeenCalledWith("mention-3", "NEUTRAL", 0);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[Sentiment] scoring unavailable for mention mention-3 — all providers (anthropic, openai) failed",
      ),
    );
  });

  it("persists NEUTRAL/0 without an error log when the AI responds but with non-JSON content", async () => {
    const generateContentWithFallback = vi.fn().mockResolvedValue("I cannot determine sentiment.");

    const result = await scoreMentionSentiment("mention-4", "ambiguous text", {
      generateContentWithFallback,
      updateMention,
      providersAttempted: ["anthropic", "openai"],
    });

    expect(result).toEqual({ mentionId: "mention-4", sentiment: "NEUTRAL", score: 0 });
    expect(updateMention).toHaveBeenCalledWith("mention-4", "NEUTRAL", 0);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
