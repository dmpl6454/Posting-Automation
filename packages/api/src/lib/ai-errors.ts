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
 * Detects AI-provider billing / permission / quota rejections — e.g. Google's
 * "403 Lightning dunning decision is deny ... PERMISSION_DENIED" (a billing
 * hold on the Cloud project), OpenAI "insufficient_quota" / "billing", or a
 * generic 401/403 PERMISSION_DENIED. These are operational (not the user's
 * fault and not a missing key), so we map them to a clear, non-leaking message
 * rather than surfacing raw provider internals like project IDs.
 */
export function isProviderBillingError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("permission_denied") ||
    msg.includes("dunning") ||
    msg.includes("insufficient_quota") ||
    msg.includes("billing") ||
    msg.includes("quota exceeded") ||
    /\b(401|403)\b/.test(msg) && (msg.includes("forbidden") || msg.includes("denied"))
  );
}

/**
 * Map any AI error to a short, user-facing message with NO raw provider
 * internals (project IDs, stack traces, env-var names). Use for progress-log
 * lines and toasts so users see something actionable, not a Google JSON blob.
 */
export function friendlyAIMessage(error: unknown): string {
  if (isMissingAIKeyError(error)) {
    return "AI provider not configured — ask your workspace admin to set the API key.";
  }
  if (isProviderBillingError(error)) {
    return "The AI image/video provider is temporarily unavailable (billing or permission issue). Captions were still generated; please try again later or contact your admin.";
  }
  const raw = error instanceof Error ? error.message : String(error ?? "");
  // Strip any leaked Google project IDs / long JSON before showing.
  if (/projects\/\d+|"status"\s*:/.test(raw)) {
    return "Image/video generation failed due to a provider error. Captions were still generated.";
  }
  return raw || "AI request failed. Please try again.";
}

/**
 * Wrap a thrown AI error into a user-friendly TRPCError.
 *
 * - Missing-key/config errors → PRECONDITION_FAILED "AI Provider Not Configured"
 *   (a 412 the UI can show as a clear "ask your admin to set the API key"
 *   message, rather than a raw 500 leaking the env-var name).
 * - Billing/permission/quota rejections → PRECONDITION_FAILED with a clear,
 *   non-leaking "temporarily unavailable" message (no raw project IDs).
 * - Anything else → INTERNAL_SERVER_ERROR with a sanitized message.
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
  if (isProviderBillingError(error)) {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "The AI provider is temporarily unavailable (billing or permission issue). Please try again later or contact your workspace admin.",
    });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: friendlyAIMessage(error),
  });
}
