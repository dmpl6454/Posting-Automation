import { NextResponse } from "next/server";
import { sentryEnvConfig } from "~/lib/sentry-options";

/**
 * Runtime settings the browser needs (2026-11-10). The dashboard pages are
 * pre-rendered at build time, so they cannot read a runtime env var; the
 * browser asks here instead. A Sentry DSN is public by design (it only allows
 * SENDING events), so this needs no session.
 */
export const dynamic = "force-dynamic";

export function GET() {
  const cfg = sentryEnvConfig();
  return NextResponse.json(
    cfg.dsn
      ? { sentry: { dsn: cfg.dsn, environment: cfg.environment, tracesSampleRate: cfg.tracesSampleRate, release: cfg.release } }
      : { sentry: null },
    { headers: { "Cache-Control": "public, max-age=300" } }
  );
}
