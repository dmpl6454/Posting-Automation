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

// Require org membership — auto-resolves or creates a default org
export const orgProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const userId = (ctx.session.user as any).id;
  let organizationId = ctx.organizationId;

  // If no org ID provided, find the user's first org or create one
  if (!organizationId) {
    const existingMembership = await ctx.prisma.organizationMember.findFirst({
      where: { userId },
      select: { organizationId: true },
    });

    if (existingMembership) {
      organizationId = existingMembership.organizationId;
    } else {
      // Auto-create a default organization for the user
      const userEmail = (ctx.session.user as any).email || "user";
      const orgName = `${userEmail.split("@")[0]}'s Workspace`;
      const org = await ctx.prisma.organization.create({
        data: {
          name: orgName,
          slug: `org-${userId.slice(0, 8)}-${Date.now()}`,
          members: {
            create: {
              userId,
              role: "OWNER",
            },
          },
        },
      });
      organizationId = org.id;
    }
  }

  const membership = await ctx.prisma.organizationMember.findUnique({
    where: {
      userId_organizationId: {
        userId,
        organizationId,
      },
    },
  });
  if (!membership) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Not a member of this organization" });
  }
  return next({
    ctx: {
      ...ctx,
      organizationId,
      membership,
    },
  });
});
