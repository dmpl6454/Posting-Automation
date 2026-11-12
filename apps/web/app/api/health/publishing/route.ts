import { NextResponse } from "next/server";
import { getPublishingHealth } from "@postautomation/api/src/lib/publishing-health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Publishing health (2026-11-12): is the worker actually sending posts?
 *
 * 200 only when the scheduled-post scan ran in the last 3 minutes AND no
 * scheduled post sits more than 10 minutes past its time. Anything else is a
 * 503, so an uptime monitor (the "Publishing monitor" GitHub workflow, or any
 * external pinger) can alert on the status code alone.
 *
 * Read by: the dashboard banner, the deploy gate in scripts/deploy.sh, and the
 * scheduled monitor. Carries counts only — no post, org or user data.
 * Cached 30s server-side.
 */
export async function GET() {
  const health = await getPublishingHealth();
  return NextResponse.json(health, {
    status: health.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
  });
}
