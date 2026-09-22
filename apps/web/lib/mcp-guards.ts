import { MCP_SCOPES, type McpScope } from "@postautomation/api/src/lib/mcp-oauth";
import { createRateLimiter } from "@postautomation/api/src/middleware/rate-limit";

/**
 * Guards that sit between an AI client and a side effect (2026-09-22).
 *
 * The scope check answers "is this client allowed to publish at all?". These
 * answer the questions that remain once it is: how OFTEN, and what leaks back
 * out when something fails.
 */

/**
 * 🔴 A LOOPING MODEL IS THE REALISTIC FAILURE MODE, not a malicious one.
 *
 * `publish_post` fans out to every channel on the post and is irreversible. An
 * assistant that misreads a "did it work?" reply as "do it again", or a client
 * that retries a call whose response it never saw, can put the same content on a
 * live audience account repeatedly — the duplicate-post class CLAUDE.md devotes
 * a whole section to, arrived at from a new direction. `enforcePlanLimit` does
 * not help: BILLING_DISABLED is true in production, so every quota is a no-op.
 *
 * ⚠️ Per PROCESS, like the `aiRateLimiter` it copies. The web container runs
 * several Next.js workers, so the real ceiling is this times the worker count.
 * That is a backstop against a runaway loop, not a quota — do not present it as
 * one.
 */
const publishLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 20 });
const writeLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

export function checkMcpActionLimit(
  scope: McpScope,
  key: string
): { ok: true } | { ok: false; message: string } {
  if (scope === MCP_SCOPES.READ) return { ok: true };
  const isPublish = scope === MCP_SCOPES.PUBLISH;
  const limiter = isPublish ? publishLimiter : writeLimiter;
  const res = limiter(`${scope}:${key}`);
  if (res.success) return { ok: true };
  return {
    ok: false,
    message: isPublish
        ? `Too many publish attempts. This connector is limited to protect live accounts from an accidental loop; it resets at ${res.resetAt.toISOString()}. If this was intentional, publish from the dashboard.`
        : `Too many write attempts. Try again after ${res.resetAt.toISOString()}.`,
  };
}

/**
 * 🔴 ERRORS LEAVE THE PROCESS TOO — redaction that only runs on the success path
 * is half a control.
 *
 * A thrown message is not authored for a model's eyes: Prisma embeds field
 * values in constraint violations, and a provider error can quote the request it
 * sent, which for a Meta call carries `access_token`. That message goes into the
 * model's context and therefore to the model vendor, exactly like a tool result.
 *
 * Patterns, not field names, because an error message has no fields. Anything
 * unrecognised is still truncated: an enormous message is itself a sign that a
 * payload got spliced into it.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Our own issued credentials.
  [/mcp_(?:at|rt)_[A-Za-z0-9_-]{8,}/g, "[redacted-token]"],
  // Encrypted channel credentials as stored.
  [/enc:v1:[A-Za-z0-9+/=:_-]{8,}/g, "[redacted-token]"],
  // Meta / Google / generic bearer material named in a query string or JSON.
  [/((?:access_token|refresh_token|client_secret|api_key|apikey|password|token)["'\s:=]+)[^"'&\s,}]{8,}/gi, "$1[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]"],
  // Long unbroken high-entropy runs: JWTs, Meta page tokens, base64 blobs.
  [/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted-long-value]"],
];

const MAX_ERROR_LENGTH = 600;

export function sanitizeErrorMessage(raw: unknown): string {
  let msg = typeof raw === "string" ? raw : (raw as any)?.message;
  if (typeof msg !== "string" || !msg.trim()) return "The request failed.";
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    msg = msg.replace(pattern, replacement);
  }
  if (msg.length > MAX_ERROR_LENGTH) {
    msg = `${msg.slice(0, MAX_ERROR_LENGTH)}… [truncated]`;
  }
  return msg;
}
