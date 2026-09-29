import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { SignJWT } from "jose";
import crypto from "crypto";
import { createRouter, superAdminProcedure, protectedProcedure } from "../../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../../lib/audit";

export const adminUsersRouter = createRouter({
  list: superAdminProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
        search: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { limit, cursor, search } = input;

      const where: any = {};
      if (search) {
        where.OR = [
          { name: { contains: search, mode: "insensitive" } },
          { email: { contains: search, mode: "insensitive" } },
        ];
      }

      const items = await ctx.prisma.user.findMany({
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        where,
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          isSuperAdmin: true,
          appRole: true,
          isBanned: true,
          createdAt: true,
          _count: { select: { memberships: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      let nextCursor: string | undefined;
      if (items.length > limit) {
        const next = items.pop()!;
        nextCursor = next.id;
      }

      return { items, nextCursor };
    }),

  getById: superAdminProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const user = await ctx.prisma.user.findUnique({
        where: { id: input.id },
        include: {
          memberships: {
            include: {
              organization: {
                select: { id: true, name: true, slug: true, plan: true },
              },
            },
          },
        },
      });
      if (!user) throw new TRPCError({ code: "NOT_FOUND" });
      return user;
    }),

  toggleSuperAdmin: superAdminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.prisma.user.findUnique({
        where: { id: input.userId },
        select: { isSuperAdmin: true },
      });
      if (!user) throw new TRPCError({ code: "NOT_FOUND" });

      // Guard against demoting the last super admin
      if (user.isSuperAdmin) {
        const superAdminCount = await ctx.prisma.user.count({
          where: { isSuperAdmin: true, deletedAt: null },
        });
        if (superAdminCount <= 1) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Cannot demote the last super admin",
          });
        }
      }

      const updated = await ctx.prisma.user.update({
        where: { id: input.userId },
        data: { isSuperAdmin: !user.isSuperAdmin },
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.ADMIN_USER_SUPERADMIN_TOGGLED,
        entityType: "User",
        entityId: input.userId,
        metadata: { newValue: updated.isSuperAdmin },
      }).catch(() => {});

      return updated;
    }),

  /**
   * App-level RBAC (2026-07-17): flip a user between USER (limited: Dashboard,
   * Content Studio, Super Agent, Media, Insights, Channels) and ADMIN (all
   * feature areas). Orthogonal to isSuperAdmin — a super admin passes every
   * appRole gate regardless of this value, so demoting a super admin's appRole
   * has no effect until their super-admin flag is also removed.
   * Enforcement is DB-fresh per request (jwt callback re-reads the User row),
   * so changes take effect immediately server-side; the target user's cached
   * nav updates on their next page reload.
   */
  setAppRole: superAdminProcedure
    .input(z.object({ userId: z.string(), appRole: z.enum(["USER", "ADMIN"]) }))
    .mutation(async ({ ctx, input }) => {
      const updated = await ctx.prisma.user.update({
        where: { id: input.userId },
        data: { appRole: input.appRole },
        select: { id: true, email: true, appRole: true },
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.ADMIN_USER_APPROLE_CHANGED,
        entityType: "User",
        entityId: input.userId,
        metadata: { newValue: updated.appRole },
      }).catch(() => {});

      return updated;
    }),

  toggleBan: superAdminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.prisma.user.findUnique({
        where: { id: input.userId },
        select: { isBanned: true },
      });
      if (!user) throw new TRPCError({ code: "NOT_FOUND" });

      const updated = await ctx.prisma.user.update({
        where: { id: input.userId },
        data: { isBanned: !user.isBanned },
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        action: updated.isBanned
          ? AUDIT_ACTIONS.ADMIN_USER_BANNED
          : AUDIT_ACTIONS.ADMIN_USER_UNBANNED,
        entityType: "User",
        entityId: input.userId,
      }).catch(() => {});

      return updated;
    }),

  delete: superAdminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: input.userId },
          data: { deletedAt: new Date() },
        });
        await tx.organizationMember.deleteMany({
          where: { userId: input.userId },
        });
        await tx.session.deleteMany({
          where: { userId: input.userId },
        });
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.ADMIN_USER_DELETED,
        entityType: "User",
        entityId: input.userId,
      }).catch(() => {});

      return { success: true };
    }),

  impersonate: superAdminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const target = await ctx.prisma.user.findUnique({
        where: { id: input.userId },
        select: { isSuperAdmin: true },
      });
      if (!target) throw new TRPCError({ code: "NOT_FOUND" });
      if (target.isSuperAdmin) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cannot impersonate a super admin",
        });
      }

      const adminId = (ctx.session.user as any).id as string;
      // Security audit 2026-09-28: a single-slot revocation marker. Writing
      // it onto the admin's OWN row (a) makes stopImpersonation an actual
      // server-side kill switch (trpc.ts's verifier requires payload.jti to
      // match this value) and (b) auto-invalidates any earlier dangling
      // token from the same admin — there is only ever one live token per
      // admin by construction.
      const jti = crypto.randomUUID();
      await ctx.prisma.user.update({
        where: { id: adminId },
        data: { activeImpersonationJti: jti },
      });

      const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET);
      const token = await new SignJWT({
        impersonatedUserId: input.userId,
        adminUserId: adminId,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setJti(jti)
        .setExpirationTime("1h")
        .sign(secret);

      createAuditLog({
        userId: adminId,
        action: AUDIT_ACTIONS.ADMIN_USER_IMPERSONATED,
        entityType: "User",
        entityId: input.userId,
      }).catch(() => {});

      return { token };
    }),

  /**
   * Security audit 2026-09-28: was `superAdminProcedure`, which made this
   * mutation UNREACHABLE in its one real use case. protectedProcedure's
   * session swap (trpc.ts) runs BEFORE superAdminProcedure's own gate in the
   * middleware chain, and the swapped session's isSuperAdmin is always false
   * (buildImpersonatedSession) — so calling this WHILE impersonating always
   * threw FORBIDDEN before the body ever ran. Now protectedProcedure, gated
   * on ctx.isImpersonating instead: it clears the issuing admin's
   * activeImpersonationJti, which is what actually revokes the token
   * (rather than the previous no-op that only told the CLIENT to delete its
   * cookie, leaving the token itself fully valid for the rest of its hour).
   */
  stopImpersonation: protectedProcedure.mutation(async ({ ctx }) => {
    if (!(ctx as any).isImpersonating || !(ctx as any).adminUserId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Not currently impersonating." });
    }
    const adminUserId = (ctx as any).adminUserId as string;

    await ctx.prisma.user.update({
      where: { id: adminUserId },
      data: { activeImpersonationJti: null },
    });

    createAuditLog({
      userId: adminUserId,
      action: AUDIT_ACTIONS.ADMIN_USER_IMPERSONATION_ENDED,
      entityType: "User",
      entityId: (ctx.session.user as any).id,
    }).catch(() => {});

    return { success: true };
  }),
});
