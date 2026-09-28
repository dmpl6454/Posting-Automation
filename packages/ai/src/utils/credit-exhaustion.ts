/**
 * "The provider account is out of money" — a FINAL failure, never a retry.
 *
 * 🔴 Why this exists (production, 2026-09-28). OpenAI answers an empty account
 * with HTTP 429, `type: "insufficient_quota"` and — since some time before
 * 2026-09-24 — `code: "credit_balance_exhausted"`. LangChain's AsyncCaller only
 * stops retrying on `error.code === "insufficient_quota"`, so it read the 429 as
 * an ordinary rate limit and retried it 6 times with exponential backoff: ~95s
 * per call, spent waiting for money that was never going to arrive. The caption
 * fan-out makes one call per 10 channels, so a 240-Page post sat parked for
 * ~40 minutes before anything reported failure.
 *
 * Matched on STRUCTURE first (status, the SDK's parsed `error` body, codes) and
 * on message wording only as a fallback, because providers re-word messages.
 * Deliberately narrow: a per-minute rate limit ("Rate limit reached…", Gemini's
 * "Quota exceeded for metric … per minute") is transient and must stay retried.
 */

const CREDIT_CODES = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "billing_hard_limit_reached",
  "billing_not_active",
]);

const CREDIT_MESSAGE =
  /no credits remaining|credit balance is too low|exceeded your current quota|prepayment credits are depleted|credit_balance_exhausted|billing_hard_limit_reached/i;

export function isProviderCreditExhausted(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    status?: unknown;
    response?: { status?: unknown };
    error?: unknown;
    code?: unknown;
    type?: unknown;
    message?: unknown;
  };

  if (Number(e.status ?? e.response?.status) === 402) return true;

  const body = e.error && typeof e.error === "object" ? (e.error as { type?: unknown; code?: unknown }) : undefined;
  if (body) {
    if (body.type === "insufficient_quota") return true;
    if (typeof body.code === "string" && CREDIT_CODES.has(body.code)) return true;
  }
  if (typeof e.code === "string" && CREDIT_CODES.has(e.code)) return true;
  if (e.type === "insufficient_quota") return true;

  return typeof e.message === "string" && CREDIT_MESSAGE.test(e.message);
}

/** Statuses LangChain's own default handler refuses to retry (kept identical). */
const STATUS_NO_RETRY = new Set([400, 401, 402, 403, 404, 405, 406, 407, 409]);

/**
 * `onFailedAttempt` for every LangChain text model we construct.
 *
 * Throwing ends the retry loop (p-retry rejects with what we throw); returning
 * lets it retry. It reproduces LangChain's built-in default exactly — that
 * function is module-private, so it cannot be delegated to — and adds the one
 * rule it lacks: an out-of-credit error is final.
 *
 * ⚠️ It rethrows the ORIGINAL error, not a wrapper, so `status` / `error.code`
 * survive for downstream classifiers (friendlyAIMessage, the fan-out's
 * short-circuit). LangChain's own quota branch replaces the error with a bare
 * `new Error(message)`, which throws that information away.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function aiFailedAttemptHandler(error: any): void {
  const message = typeof error?.message === "string" ? error.message : "";
  if (message.startsWith("Cancel") || message.startsWith("AbortError") || error?.name === "AbortError") {
    throw error;
  }
  if (error?.code === "ECONNABORTED") throw error;

  const status = Number(error?.response?.status ?? error?.status);
  if (status && STATUS_NO_RETRY.has(status)) throw error;

  if (isProviderCreditExhausted(error)) throw error;
}
