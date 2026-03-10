import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@postautomation/api";

export const trpc = createTRPCReact<AppRouter>();
