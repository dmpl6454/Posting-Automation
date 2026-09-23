/**
 * Was a failed comment reply REFUSED (nothing was posted — safe to fix and
 * resend), or is its outcome UNKNOWN (it may already be live — resending can
 * publish a duplicate public reply as the brand's Page)?
 *
 * Creating a reply is not idempotent, so every failure we cannot prove was a
 * refusal is "unconfirmed" — the 2026-08-18 duplicate-post lesson applied one
 * severity tier down.
 *
 *  unconfirmed:
 *   - the provider said so ("…may already be posted": Meta timeout, any 5xx,
 *     `is_transient` / code 2, an OK response without an id);
 *   - our OWN API call died without a tRPC error envelope (network drop, an
 *     nginx 502/504 HTML page): the server may have finished the Graph POST
 *     after the browser gave up;
 *   - our server answered 5xx.
 *  refused:
 *   - a rate limit (ours, or nginx's 429 page) — the request never reached Meta;
 *   - any structured 4xx from our API (validation, permission, gone, throttle…).
 */
export type ReplyFailureKind = "unconfirmed" | "refused";

interface ErrorLike {
  message?: string;
  data?: { code?: string; httpStatus?: number } | null;
}

export function classifyReplyFailure(err: ErrorLike | null | undefined): ReplyFailureKind {
  const message = String(err?.message ?? "");
  if (/may already be posted/i.test(message)) return "unconfirmed";
  if (err?.data?.code === "TOO_MANY_REQUESTS" || /too many requests|a lot of comment activity/i.test(message)) {
    return "refused";
  }
  if (!err?.data) return "unconfirmed";
  if ((err.data.httpStatus ?? 0) >= 500) return "unconfirmed";
  return "refused";
}
