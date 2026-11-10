import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter, createTRPCContext } from "@postautomation/api";
import { auth } from "~/lib/auth";
import * as Sentry from "@sentry/node";

// Allow large payloads (AI image generation returns base64 data)
export const dynamic = "force-dynamic";
export const maxDuration = 600; // 10 minutes — repurpose (carousel/reel/video) can take 5-10 min

const handler = async (req: Request) => {
  const session = await auth();
  const orgId = req.headers.get("x-organization-id") || undefined;

  // Read impersonation cookie for super admin user switching
  const cookieHeader = req.headers.get("cookie") || "";
  const impersonationToken = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("admin-impersonate="))
    ?.split("=")
    .slice(1)
    .join("=") || undefined;

  // One Sentry span per tRPC request (2026-11-10), named after the procedures
  // in the (possibly batched) call — this is what shows WHICH call is slow.
  // Sampled by SENTRY_TRACES_SAMPLE_RATE; a plain pass-through when Sentry is off.
  const procedures = new URL(req.url).pathname.replace(/^\/api\/trpc\/?/, "").slice(0, 200) || "unknown";
  return Sentry.startSpan({ name: `trpc ${procedures}`, op: "http.server", forceTransaction: true }, () => fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () =>
      createTRPCContext({
        session,
        organizationId: orgId,
        impersonationToken,
      }),
    // Report genuine server faults to Sentry (2026-11-10). Expected outcomes —
    // bad input, not signed in, forbidden, not found, rate limited — are the
    // app working as designed and are not reported. A no-op unless SENTRY_DSN
    // started Sentry (instrumentation.ts). Only the opaque user id is attached.
    onError: ({ error, path }) => {
      if (error.code !== "INTERNAL_SERVER_ERROR") return;
      Sentry.withScope((scope) => {
        scope.setTag("trpc.path", path ?? "unknown");
        if (orgId) scope.setTag("org", orgId);
        const userId = (session?.user as { id?: string } | undefined)?.id;
        if (userId) scope.setUser({ id: userId });
        Sentry.captureException(error.cause ?? error);
      });
    },
  }));
};

export { handler as GET, handler as POST };
