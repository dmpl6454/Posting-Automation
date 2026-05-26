/**
 * Error humanization helpers.
 * Never expose raw technical error messages to end users in toasts.
 */

const TECHNICAL_PATTERNS = [
  /^Invariant/i,
  /at .+:\d+:\d+/,
  /Cannot read prop/i,
  /TypeError/i,
  /TRPCError/i,
  /\bPrisma\b/i,
  /Internal server error/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
];

/**
 * Convert an unknown error (tRPC, fetch, etc.) into a user-friendly string.
 * Returns `fallback` if the message looks technical or is too long.
 */
export function humanizeError(
  err: unknown,
  fallback = "Something went wrong. Please try again."
): string {
  const msg =
    typeof err === "string"
      ? err
      : (err as any)?.message ?? "";
  if (!msg) return fallback;
  if (TECHNICAL_PATTERNS.some((re) => re.test(msg))) return fallback;
  if (msg.length > 240) return fallback;
  return msg;
}
