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
  // JSON-parse failures from non-JSON responses (e.g. an HTML error page fed
  // to res.json() by @trpc/client) — never show the raw SyntaxError text.
  /unexpected token/i,
  /is not valid JSON/i,
  /^SyntaxError/i,
  /unexpected end of JSON/i,
];

/**
 * Convert an unknown error (tRPC, fetch, etc.) into a user-friendly string.
 * Returns `fallback` if the message looks technical or is too long.
 */
export function humanizeError(
  err: unknown,
  fallback = "Something went wrong. Please try again."
): string {
  // Prefer the structured Zod error the tRPC errorFormatter already populates
  // (shape: { formErrors: string[], fieldErrors: Record<string, string[]> }).
  const zodError = (err as any)?.data?.zodError;
  if (zodError && typeof zodError === "object") {
    const formErrors: string[] | undefined = zodError.formErrors;
    const fieldErrors: Record<string, string[] | undefined> | undefined = zodError.fieldErrors;
    const firstField = fieldErrors
      ? Object.values(fieldErrors).flat().filter(Boolean)[0]
      : undefined;
    const first = formErrors?.[0] ?? firstField;
    if (first) return String(first);
    return "Please check the highlighted fields and try again.";
  }

  const msg =
    typeof err === "string"
      ? err
      : (err as any)?.message ?? "";
  if (!msg) return fallback;
  // A raw Zod issue array leaks as JSON starting with "[{" — never show it.
  if (msg.trim().startsWith("[{")) return "Please check your input and try again.";
  if (TECHNICAL_PATTERNS.some((re) => re.test(msg))) return fallback;
  if (msg.length > 240) return fallback;
  return msg;
}
