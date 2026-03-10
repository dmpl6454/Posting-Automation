/**
 * Sentry helper wrappers for the API package.
 *
 * These functions conditionally forward to @sentry/node when the package is
 * installed and a DSN is configured.  If Sentry is not available the calls
 * are silently no-ops, so routers can call `captureError(err)` without
 * importing Sentry directly or worrying about optional-dependency issues.
 */

type SeverityLevel = "fatal" | "error" | "warning" | "log" | "info" | "debug";

interface SentryLike {
  captureException: (error: unknown, context?: Record<string, unknown>) => string;
  captureMessage: (message: string, level?: SeverityLevel | Record<string, unknown>) => string;
}

let _sentry: SentryLike | null = null;
let _resolved = false;

function getSentry(): SentryLike | null {
  if (_resolved) return _sentry;
  _resolved = true;

  try {
    // Dynamic require so the build does not fail when @sentry/node is absent
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@sentry/node") as SentryLike;
    if (mod && typeof mod.captureException === "function") {
      _sentry = mod;
    }
  } catch {
    // @sentry/node not installed — no-op
  }

  return _sentry;
}

/**
 * Report an error to Sentry (if available).
 *
 * @param error  The error or throwable value
 * @param context  Optional extra context attached to the event
 */
export function captureError(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  const sentry = getSentry();
  if (!sentry) return;

  try {
    sentry.captureException(error, context ? { extra: context } : undefined);
  } catch {
    // Never let Sentry itself break the caller
    console.error("[sentry-helpers] Failed to capture exception:", error);
  }
}

/**
 * Send an ad-hoc message to Sentry (if available).
 *
 * @param message  A human-readable message string
 * @param level    Sentry severity level (default: "error")
 * @param context  Optional extra context attached to the event
 */
export function captureMessage(
  message: string,
  level: SeverityLevel = "error",
  context?: Record<string, unknown>,
): void {
  const sentry = getSentry();
  if (!sentry) return;

  try {
    sentry.captureMessage(message, context ? { level, extra: context } as unknown as Record<string, unknown> : level);
  } catch {
    console.error("[sentry-helpers] Failed to capture message:", message);
  }
}
