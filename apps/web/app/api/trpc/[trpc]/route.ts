import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter, createTRPCContext } from "@postautomation/api";
import { auth } from "~/lib/auth";

const handler = async (req: Request) => {
  const session = await auth();
  const orgId = req.headers.get("x-organization-id") || undefined;

  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () =>
      createTRPCContext({
        session,
        organizationId: orgId,
      }),
  });
};

export { handler as GET, handler as POST };
