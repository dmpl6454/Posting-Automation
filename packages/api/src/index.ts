export { appRouter } from "./root";
export type { AppRouter } from "./root";
export { createTRPCContext, createCallerFactory } from "./trpc";
export type { TRPCContext } from "./trpc";
export { openApiSpec } from "./openapi/generate-spec";

// Re-export from db so api consumers can import preauth helpers from @postautomation/api
export { getPreauthOrgData, PREAUTH_EMAILS } from "@postautomation/db";
