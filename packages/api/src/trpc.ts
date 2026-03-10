import { initTRPC, TRPCError } from "@trpc/server";
import type { Session } from "next-auth";
import superjson from "superjson";
import { ZodError } from "zod";
import { prisma } from "@postautomation/db";

export interface TRPCContext {
  prisma: typeof prisma;
  session: Session | null;
  organizationId?: string;
}

export const createTRPCContext = async (opts: {
  session: Session | null;
  organizationId?: string;
}): Promise<TRPCContext> => {
  return {
    prisma,
    session: opts.session,
    organizationId: opts.organizationId,
  };
};

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createRouter = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;

// Require authenticated session
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      ...ctx,
      session: ctx.session as Session & { user: { id: string; email: string } },
    },
  });
});

// Require org membership
export const orgProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.organizationId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Organization ID required",
    });
  }
  const membership = await ctx.prisma.organizationMember.findUnique({
    where: {
      userId_organizationId: {
        userId: (ctx.session.user as any).id,
        organizationId: ctx.organizationId,
      },
    },
  });
  if (!membership) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Not a member of this organization" });
  }
  return next({
    ctx: {
      ...ctx,
      organizationId: ctx.organizationId,
      membership,
    },
  });
});
