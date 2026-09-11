import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, superAdminProcedure } from "../../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../../lib/audit";
import { listAllMetaApps, isKnownMetaAppId } from "@postautomation/social";

export const adminOrgsRouter = createRouter({
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
          { slug: { contains: search, mode: "insensitive" } },
        ];
      }

      const items = await ctx.prisma.organization.findMany({
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        where,
        include: {
          _count: {
            select: { members: true, posts: true, channels: true },
          },
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
      const org = await ctx.prisma.organization.findUnique({
        where: { id: input.id },
        include: {
          members: {
            include: {
              user: {
                select: { id: true, name: true, email: true, image: true },
              },
            },
          },
          channels: true,
          posts: {
            take: 10,
            orderBy: { createdAt: "desc" },
          },
        },
      });
      if (!org) throw new TRPCError({ code: "NOT_FOUND" });
      return org;
    }),

  changePlan: superAdminProcedure
    .input(
      z.object({
        organizationId: z.string(),
        plan: z.enum(["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const org = await ctx.prisma.organization.update({
        where: { id: input.organizationId },
        data: { plan: input.plan },
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        organizationId: input.organizationId,
        action: AUDIT_ACTIONS.ADMIN_ORG_PLAN_CHANGED,
        entityType: "Organization",
        entityId: input.organizationId,
        metadata: { newPlan: input.plan },
      }).catch(() => {});

      return org;
    }),

  delete: superAdminProcedure
    .input(z.object({ organizationId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.organization.delete({
        where: { id: input.organizationId },
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        organizationId: input.organizationId,
        action: AUDIT_ACTIONS.ADMIN_ORG_DELETED,
        entityType: "Organization",
        entityId: input.organizationId,
      }).catch(() => {});

      return { success: true };
    }),

  /**
   * Lists the Meta apps this deployment is configured for, so the admin UI can
   * offer a real choice instead of a free-text app id.
   *
   * Returns ids only — never secrets.
   */
  metaApps: superAdminProcedure.query(() => {
    return listAllMetaApps().map((app) => ({
      appId: app.appId,
      legacy: app.legacy,
    }));
  }),

  /**
   * Pins an organization to a specific Meta app for its NEW Facebook/Instagram
   * connections. `null` restores the legacy app.
   *
   * ── Why superAdminProcedure and not adminOrgProcedure ───────────────────────
   * `requireAppAdmin` begins with `if (process.env.RBAC_DISABLED === "true")
   * return;` — a documented emergency kill switch that turns EVERY appRole gate
   * into a no-op. Gating this on appRole would make it settable by any
   * authenticated org member the instant that switch is flipped.
   * `superAdminProcedure` has no such bypass. Impersonation is also relevant:
   * `buildImpersonatedSession` clears `isSuperAdmin` but NOT `appRole`, so an
   * appRole gate would additionally be reachable while impersonating.
   *
   * ⚠️ This does NOT migrate existing channels. Their tokens stay bound to the
   * app that minted them (Channel.metaAppId); only the next connect changes.
   */
  setMetaApp: superAdminProcedure
    .input(
      z.object({
        organizationId: z.string(),
        // null = legacy app. Bounded length so an absurd value can never reach
        // a query.
        metaAppId: z.string().min(1).max(64).nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Validate BEFORE writing: an unknown id would strand every future
      // connect for this org on a null credential resolution, surfacing only
      // when a user clicks Connect.
      if (input.metaAppId !== null && !isKnownMetaAppId("FACEBOOK", input.metaAppId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            `Meta app ${input.metaAppId} is not configured on this server. ` +
            `Configured apps: ${listAllMetaApps().map((a) => a.appId).join(", ") || "(none)"}.`,
        });
      }

      const org = await ctx.prisma.organization.findUnique({
        where: { id: input.organizationId },
        select: { id: true, metaAppId: true },
      });
      if (!org) throw new TRPCError({ code: "NOT_FOUND", message: "Organization not found" });

      await ctx.prisma.organization.update({
        where: { id: input.organizationId },
        data: { metaAppId: input.metaAppId },
      });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        organizationId: input.organizationId,
        action: AUDIT_ACTIONS.ADMIN_ORG_META_APP_CHANGED,
        entityType: "Organization",
        entityId: input.organizationId,
        metadata: { from: org.metaAppId ?? null, to: input.metaAppId },
      }).catch(() => {});

      return { success: true, metaAppId: input.metaAppId };
    }),
});
