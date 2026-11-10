import {
  scrubSentryEvent,
  scrubValue,
  sentrySampleRate,
} from "@postautomation/queue/src/sentry-scrub";

/**
 * Shared Sentry options for the web server and the browser (2026-11-10).
 *
 * - ONE setting turns it on: `SENTRY_DSN`. Unset/empty ⇒ Sentry never starts.
 * - `SENTRY_TRACES_SAMPLE_RATE` (0..1, default 0.1) = share of requests/page
 *   loads traced for performance; errors are always sent.
 * - Every event, transaction and breadcrumb goes through the scrubber, and no
 *   session replay is recorded (captions and DMs are user content).
 */
export function sentryBaseOptions(cfg: { dsn: string; environment?: string; tracesSampleRate?: number; release?: string }) {
  return {
    dsn: cfg.dsn,
    environment: cfg.environment || "production",
    release: cfg.release || undefined,
    tracesSampleRate: cfg.tracesSampleRate ?? 0.1,
    sendDefaultPii: false,
    beforeSend: (event: any) => scrubSentryEvent(event),
    beforeSendTransaction: (event: any) => scrubSentryEvent(event),
    beforeBreadcrumb: (breadcrumb: any) => scrubValue(breadcrumb),
  };
}

/** Server-side reading of the Sentry env, used by instrumentation and the client-config route. */
export function sentryEnvConfig() {
  const dsn = (process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || "").trim();
  return {
    dsn,
    environment: (process.env.SENTRY_ENVIRONMENT || "production").trim(),
    tracesSampleRate: sentrySampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.1),
    release: process.env.NEXT_PUBLIC_COMMIT_HASH && process.env.NEXT_PUBLIC_COMMIT_HASH !== "unknown"
      ? process.env.NEXT_PUBLIC_COMMIT_HASH
      : undefined,
  };
}
