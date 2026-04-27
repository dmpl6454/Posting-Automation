import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter, createTRPCContext } from "@postautomation/api";
import { auth } from "~/lib/auth";

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

  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () =>
      createTRPCContext({
        session,
        organizationId: orgId,
        impersonationToken,
      }),
  });
};

export { handler as GET, handler as POST };
