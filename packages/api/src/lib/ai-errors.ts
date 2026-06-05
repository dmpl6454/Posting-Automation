import { TRPCError } from "@trpc/server";

/**
 * Detects AI-provider "missing/!configured API key" errors.
 *
 * Providers throw plain Errors like:
 *   - "OpenAI API key not found. Set OPENAI_API_KEY ..."
 *   - "GOOGLE_GEMINI_API_KEY or GOOGLE_AI_API_KEY environment variable is required ..."
 *   - "FAL_KEY is required for AI video generation"
 *   - "Anthropic API key not found ..."
 * Left unhandled, these surface to the client as a raw HTTP 500. We want a
 * friendly, actionable message instead (ADD-5).
 */
export function isMissingAIKeyError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("api key not found") ||
    msg.includes("api key is required") ||
    (msg.includes("environment variable is required") && msg.includes("key")) ||
    (msg.includes("is required for") && msg.includes("key")) ||
    msg.includes("_api_key") ||
    msg.includes("fal_key is required") ||
    msg.includes("not configured")
  );
}

/**
 * Wrap a thrown AI error into a user-friendly TRPCError.
 *
 * - Missing-key/config errors → PRECONDITION_FAILED "AI Provider Not Configured"
 *   (a 412 the UI can show as a clear "ask your admin to set the API key"
 *   message, rather than a raw 500 leaking the env-var name).
 * - Anything else → INTERNAL_SERVER_ERROR with the original message.
 *
 * Re-throws existing TRPCErrors untouched so router-level validation errors
 * (FORBIDDEN, BAD_REQUEST, etc.) pass straight through.
 *
 * Usage:
 *   try { ...AI calls... } catch (e) { throw toFriendlyAIError(e); }
 */
export function toFriendlyAIError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;
  if (isMissingAIKeyError(error)) {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "AI Provider Not Configured. This feature needs an AI provider API key to be set. Please contact your workspace admin to configure it.",
    });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: error instanceof Error ? error.message : "AI request failed. Please try again.",
  });
}
