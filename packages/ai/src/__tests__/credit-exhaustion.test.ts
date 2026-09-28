import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AsyncCaller } from "@langchain/core/utils/async_caller";
import { isProviderCreditExhausted, aiFailedAttemptHandler } from "../utils/credit-exhaustion";
import { getOpenAIModel } from "../providers/openai.provider";
import { getDeepSeekModel } from "../providers/deepseek.provider";
import { getGrokModel } from "../providers/grok.provider";
import { getAnthropicModel } from "../providers/anthropic.provider";

/**
 * A provider that is OUT OF CREDIT must fail at once, never be retried.
 *
 * Measured on production 2026-09-28: OpenAI now answers an empty account with
 * type "insufficient_quota" but code "credit_balance_exhausted". LangChain's
 * AsyncCaller only treats code === "insufficient_quota" as final, so it read
 * the 429 as a plain rate limit and retried it 6 times with backoff — ~95s per
 * call. A 240-Page caption fan-out (24 chunks) sat parked for ~40 minutes
 * before its safety valve fired.
 *
 * The fixtures below are the VERBATIM bodies production returned, shaped the
 * way the OpenAI SDK v4 surfaces them (status + parsed `error` object).
 */

/** OpenAI, 2026-09-28, prod key — probed with a 1-token request. */
function openAiNoCreditError() {
  const body = {
    message:
      "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
    type: "insufficient_quota",
    param: null,
    code: "credit_balance_exhausted",
  };
  return Object.assign(new Error(`429 ${body.message}`), {
    status: 429,
    error: body,
    code: body.code,
    type: body.type,
  });
}

/** Anthropic, 2026-09-28, from the caption-fanout worker log. */
function anthropicNoCreditError() {
  return Object.assign(
    new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011CfW2r7nVkRBne7pNh8J8n"}'
    ),
    { status: 400 }
  );
}

/** An ordinary rate limit — genuinely transient, MUST still be retried. */
function plainRateLimitError() {
  const body = {
    message: "Rate limit reached for gpt-4o on requests per min (RPM): Limit 500, Used 500, Requested 1.",
    type: "requests",
    param: null,
    code: "rate_limit_exceeded",
  };
  return Object.assign(new Error(`429 ${body.message}`), { status: 429, error: body, code: body.code });
}

describe("isProviderCreditExhausted", () => {
  it("recognises OpenAI's current no-credit error (code credit_balance_exhausted)", () => {
    expect(isProviderCreditExhausted(openAiNoCreditError())).toBe(true);
  });

  it("still recognises OpenAI's older insufficient_quota code", () => {
    const e = Object.assign(new Error("429 You exceeded your current quota"), {
      status: 429,
      error: { type: "insufficient_quota", code: "insufficient_quota" },
    });
    expect(isProviderCreditExhausted(e)).toBe(true);
  });

  it("recognises Anthropic's credit-balance error", () => {
    expect(isProviderCreditExhausted(anthropicNoCreditError())).toBe(true);
  });

  it("recognises HTTP 402 Payment Required from any provider", () => {
    expect(isProviderCreditExhausted(Object.assign(new Error("Payment Required"), { status: 402 }))).toBe(true);
  });

  it("recognises Gemini's depleted-prepayment error", () => {
    expect(
      isProviderCreditExhausted(
        new Error('Nano Banana API error (402): {"error":{"code":402,"message":"Your prepayment credits are depleted."}}')
      )
    ).toBe(true);
  });

  it("does NOT treat an ordinary rate limit as exhaustion", () => {
    expect(isProviderCreditExhausted(plainRateLimitError())).toBe(false);
  });

  it("does NOT treat network failures, timeouts or junk as exhaustion", () => {
    expect(isProviderCreditExhausted(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }))).toBe(false);
    expect(isProviderCreditExhausted(Object.assign(new Error("Request timed out."), { name: "TimeoutError" }))).toBe(
      false
    );
    expect(isProviderCreditExhausted(undefined)).toBe(false);
    expect(isProviderCreditExhausted("boom")).toBe(false);
  });
});

describe("aiFailedAttemptHandler (the retry decision)", () => {
  it("throws — ending the retry loop — for an out-of-credit error", () => {
    expect(() => aiFailedAttemptHandler(openAiNoCreditError())).toThrow(/no credits remaining/);
  });

  it("rethrows the ORIGINAL error, so status/code survive for the friendly-message classifier", () => {
    const original = openAiNoCreditError();
    let thrown: unknown;
    try {
      aiFailedAttemptHandler(original);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(original);
  });

  it("does NOT throw for a plain rate limit (so it is retried, as before)", () => {
    expect(() => aiFailedAttemptHandler(plainRateLimitError())).not.toThrow();
  });

  it("keeps LangChain's default non-retry rules: 401 and aborts are final", () => {
    expect(() => aiFailedAttemptHandler(Object.assign(new Error("Unauthorized"), { status: 401 }))).toThrow();
    expect(() => aiFailedAttemptHandler(Object.assign(new Error("AbortError: aborted"), { name: "AbortError" }))).toThrow();
    expect(() => aiFailedAttemptHandler(Object.assign(new Error("socket"), { code: "ECONNABORTED" }))).toThrow();
  });
});

describe("with LangChain's REAL AsyncCaller (the component that did the 6 retries)", () => {
  it("an out-of-credit call is attempted exactly ONCE, not 7 times", async () => {
    const caller = new AsyncCaller({ maxRetries: 6, onFailedAttempt: aiFailedAttemptHandler });
    const fn = vi.fn(async () => {
      throw openAiNoCreditError();
    });
    await expect(caller.call(fn)).rejects.toThrow(/no credits remaining/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a plain rate limit is still retried", async () => {
    const caller = new AsyncCaller({ maxRetries: 1, onFailedAttempt: aiFailedAttemptHandler });
    const fn = vi.fn(async () => {
      throw plainRateLimitError();
    });
    await expect(caller.call(fn)).rejects.toThrow(/Rate limit reached/);
    expect(fn).toHaveBeenCalledTimes(2);
  }, 15_000);
});

describe("every text provider is built with the handler", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.stubEnv("XAI_API_KEY", "test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  });
  afterEach(() => vi.unstubAllEnvs());

  const handlerOf = (model: unknown) => (model as { caller: { onFailedAttempt: unknown } }).caller.onFailedAttempt;

  it("openai", () => expect(handlerOf(getOpenAIModel())).toBe(aiFailedAttemptHandler));
  it("deepseek", () => expect(handlerOf(getDeepSeekModel())).toBe(aiFailedAttemptHandler));
  it("grok", () => expect(handlerOf(getGrokModel())).toBe(aiFailedAttemptHandler));
  it("anthropic", () => expect(handlerOf(getAnthropicModel())).toBe(aiFailedAttemptHandler));
});
