/**
 * Next.js instrumentation hook (2026-11-10): starts Sentry on the Node server.
 * Off unless SENTRY_DSN is set. This exact `if (process.env.NEXT_RUNTIME ===
 * "nodejs")` shape is what lets the compiler drop the import from the edge
 * build — an early `return` does not.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startServerSentry } = await import("./instrumentation-node");
    await startServerSentry();
  }
}
