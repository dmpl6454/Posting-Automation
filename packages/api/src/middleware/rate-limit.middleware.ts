import { TRPCError } from "@trpc/server";
import type { TRPCContext } from "../trpc";

type RateLimitFn = (key: string) => {
  success: boolean;
  remaining: number;
  resetAt: Date;
};

/**
 * Creates a tRPC middleware that applies rate limiting.
 * Takes a rate limiter function (from createRateLimiter) as parameter.
 * Extracts user ID from context or falls back to "anonymous".
 */
export function createRateLimitMiddleware(rateLimiter: RateLimitFn) {
  // We create a standalone tRPC instance just to define the middleware type.
  // The middleware itself is generic and can be composed with any procedure.
  return function rateLimitMiddleware<T extends { ctx: TRPCContext }>({
    ctx,
    next,
  }: {
    ctx: TRPCContext;
    next: (opts?: { ctx?: Partial<TRPCContext> }) => Promise<any>;
  }) {
    const userId = ctx.session?.user
      ? (ctx.session.user as any).id ?? "anonymous"
      : "anonymous";

    const result = rateLimiter(userId);

    if (!result.success) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: `Rate limit exceeded. Try again after ${result.resetAt.toISOString()}`,
      });
    }

    return next();
  };
}
