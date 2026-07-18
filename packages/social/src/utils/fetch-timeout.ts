/**
 * fetchT — fetch with a hard timeout, for OAuth CONNECT-path calls only.
 *
 * Why: the OAuth callback runs inside a web request with a 120s nginx proxy
 * budget. A single hung platform API (token exchange, profile read, pages
 * list) used to hold the callback until nginx 504'd — burning the one-shot
 * consent code. A bounded timeout turns that into a fast, retryable error.
 *
 * Node >= 20 guarantees AbortSignal.timeout (same pattern already in prod:
 * apps/worker/src/workers/avatar-cache.worker.ts).
 *
 * Contract:
 * - Preserves every caller-provided `init` field.
 * - If the caller already passes a `signal`, THEIRS wins (no timeout added) —
 *   never silently replace an explicit abort contract.
 * - Do NOT use for publish/upload/analytics fetches: large media uploads and
 *   long polls legitimately exceed any connect-sized budget.
 */

export const DEFAULT_CONNECT_FETCH_TIMEOUT_MS = 25_000;

export function fetchT(
  url: string | URL,
  init: RequestInit = {},
  ms: number = DEFAULT_CONNECT_FETCH_TIMEOUT_MS
): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(ms),
  });
}
