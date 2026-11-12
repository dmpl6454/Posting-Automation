/**
 * Node-only Sentry start-up (2026-11-10). Imported by instrumentation.ts ONLY
 * inside its `NEXT_RUNTIME === "nodejs"` branch, so the edge build never sees
 * @sentry/node (it needs node:path, diagnostics_channel, …).
 *
 * Uses @sentry/node, NOT @sentry/nextjs: the latter declares `next` as a peer
 * and pulled a SECOND copy of next/next-auth into the install (different peer
 * set), which can break auth's request-scoped helpers. Keep it that way.
 */
export async function startServerSentry() {
  const { sentryEnvConfig, sentryBaseOptions } = await import("./lib/sentry-options");
  const cfg = sentryEnvConfig();
  if (!cfg.dsn) return;
  const Sentry = await import("@sentry/node");
  Sentry.init({
    ...sentryBaseOptions(cfg),
    serverName: "web",
    // Keep Node's own crash behaviour: Sentry's process handlers would change
    // what an uncaught error does to the server process.
    integrations: (defaults) =>
      defaults.filter((i) => i.name !== "OnUncaughtException" && i.name !== "OnUnhandledRejection"),
  });
  console.log(`[sentry] server reporting on (${cfg.environment}, traces ${cfg.tracesSampleRate})`);
}

/**
 * "Posts are not publishing" email watcher (2026-11-12). Lives in the web
 * process because the worker is what dies (2026-11-10: ~33 h, nothing sent,
 * nobody told). Production only; PUBLISHING_ALERTS_ENABLED=false turns it off.
 * Never throws — a monitoring failure must not take the website down.
 */
export async function startPublishingWatch() {
  // `next build` runs register() in its page-data workers too; importing the
  // watcher there opens a Redis connection that has no server to talk to.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NODE_ENV !== "production" || process.env.PUBLISHING_ALERTS_ENABLED === "false") return;
  try {
    const { startPublishingAlerts } = await import("@postautomation/api/src/lib/publishing-alerts");
    startPublishingAlerts();
  } catch (err) {
    console.error("[publishing-health] could not start:", err instanceof Error ? err.message : err);
  }
}
