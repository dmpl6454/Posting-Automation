import { initTRPC, TRPCError } from "@trpc/server";
import type { Session } from "next-auth";
import superjson from "superjson";
import { ZodError } from "zod";
import { prisma } from "@postautomation/db";
import { jwtVerify } from "jose";

export interface TRPCContext {
  prisma: typeof prisma;
  session: Session | null;
  organizationId?: string;
  impersonationToken?: string;
  isImpersonating?: boolean;
  adminUserId?: string;
}

export const createTRPCContext = async (opts: {
  session: Session | null;
  organizationId?: string;
  impersonationToken?: string;
}): Promise<TRPCContext> => {
  return {
    prisma,
    session: opts.session,
    organizationId: opts.organizationId,
    impersonationToken: opts.impersonationToken,
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
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  // Ban check
  if ((ctx.session.user as any).isBanned) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Account suspended" });
  }

  let session = ctx.session as Session & { user: { id: string; email: string } };
  let isImpersonating = false;
  let adminUserId: string | undefined;

  // Impersonation handling
  if (ctx.impersonationToken) {
    try {
      const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET);
      const { payload } = await jwtVerify(ctx.impersonationToken, secret);

      const impersonatedUser = await prisma.user.findUnique({
        where: { id: payload.targetUserId as string },
        select: { id: true, email: true, name: true, image: true },
      });

      if (impersonatedUser) {
        adminUserId = (session.user as any).id;
        isImpersonating = true;
        session = {
          ...session,
          user: {
            ...session.user,
            id: impersonatedUser.id,
            email: impersonatedUser.email!,
            name: impersonatedUser.name,
            image: impersonatedUser.image,
          },
        } as any;
      }
    } catch {
      // Invalid impersonation token — ignore and continue with original session
    }
  }

  return next({
    ctx: {
      ...ctx,
      session,
      isImpersonating,
      adminUserId,
    },
  });
});

// Require super admin role
export const superAdminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if ((ctx.session?.user as any)?.isSuperAdmin !== true) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Super admin access required" });
  }
  return next({ ctx });
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
