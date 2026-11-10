import * as Sentry from "@sentry/node";
import { scrubSentryEvent, scrubValue } from "@postautomation/queue/src/sentry-scrub";

/**
 * Worker error reporting (2026-11-10). Off unless SENTRY_DSN is set.
 *
 * Errors only — no performance tracing: the worker serves no HTTP requests,
 * and tracing every job would add overhead to the publish path for nothing.
 * Every event and breadcrumb goes through the shared scrubber, because worker
 * errors routinely contain Graph URLs with access tokens.
 */
let enabled = false;

export function initWorkerSentry(): boolean {
  const dsn = (process.env.SENTRY_DSN || "").trim();
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: (process.env.SENTRY_ENVIRONMENT || "production").trim(),
    serverName: "worker",
    sendDefaultPii: false,
    tracesSampleRate: 0,
    // 🔴 Drop Sentry's own process handlers. Its OnUncaughtException handler can
    // EXIT the process, and this worker deliberately stays alive on an uncaught
    // error — exiting would kill every in-flight publish mid-upload. index.ts
    // reports from its existing handlers instead (reportProcessError).
    integrations: (defaults) =>
      defaults.filter((i) => i.name !== "OnUncaughtException" && i.name !== "OnUnhandledRejection"),
    beforeSend: (event) => scrubSentryEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubValue(breadcrumb),
  });
  enabled = true;
  console.log("[sentry] worker reporting on");
  return true;
}

interface JobLike {
  id?: string;
  name?: string;
  attemptsMade?: number;
  opts?: { attempts?: number };
}

/**
 * Report a job only when it has FAILED FOR GOOD: its last attempt, or an
 * UnrecoverableError (BullMQ never retries those, and this codebase uses them
 * for terminal outcomes). A failure BullMQ will retry is not an incident yet —
 * reporting every attempt would bury real problems in rate-limit noise.
 */
export function shouldReportJobFailure(job: JobLike | undefined, err: { name?: string } | undefined): boolean {
  if (!job) return true;
  if (err?.name === "UnrecoverableError") return true;
  const attempts = job.opts?.attempts ?? 1;
  return (job.attemptsMade ?? 0) >= attempts;
}

export function reportJobFailure(queue: string, job: JobLike | undefined, err: unknown): void {
  if (!enabled) return;
  const e = err instanceof Error ? err : new Error(String(err));
  if (!shouldReportJobFailure(job, e)) return;
  Sentry.withScope((scope) => {
    scope.setTag("queue", queue);
    if (job?.name) scope.setTag("job.name", job.name);
    // Job ids carry only internal ids (e.g. `pdelete:{targetId}:{ms}`), never content.
    if (job?.id) scope.setExtra("job.id", job.id);
    scope.setExtra("attemptsMade", job?.attemptsMade ?? 0);
    // Group by queue + message so one recurring failure is one Sentry issue.
    scope.setFingerprint(["{{ default }}", queue]);
    Sentry.captureException(e);
  });
}

export function reportProcessError(err: unknown): void {
  if (!enabled) return;
  Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
}

/** Flush pending events before the process exits (shutdown path). */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!enabled) return;
  await Sentry.flush(timeoutMs).catch(() => {});
}
