import "server-only";
import { createCallerFactory, createTRPCContext } from "@postautomation/api";
import { appRouter } from "@postautomation/api";
import { auth } from "~/lib/auth";
import { headers } from "next/headers";

const createCaller = createCallerFactory(appRouter);

export async function serverTRPC() {
  const session = await auth();
  const headersList = await headers();
  const orgId = headersList.get("x-organization-id") || undefined;

  const ctx = await createTRPCContext({
    session,
    organizationId: orgId,
  });

  return createCaller(ctx);
}
