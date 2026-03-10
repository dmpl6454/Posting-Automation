import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../lib/audit";

export const teamRouter = createRouter({
  members: orgProcedure.query(async ({ ctx }) => {
    return ctx.prisma.organizationMember.findMany({
      where: { organizationId: ctx.organizationId },
      include: { user: { select: { id: true, name: true, email: true, image: true } } },
      orderBy: { createdAt: "asc" },
    });
  }),

  invite: orgProcedure
    .input(z.object({ email: z.string().email(), role: z.enum(["ADMIN", "MEMBER", "VIEWER"]).default("MEMBER") }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role !== "OWNER" && ctx.membership.role !== "ADMIN") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only owners and admins can invite members" });
      }
      const user = await ctx.prisma.user.findUnique({ where: { email: input.email } });
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found. They need to sign up first." });

      const existing = await ctx.prisma.organizationMember.findUnique({
        where: { userId_organizationId: { userId: user.id, organizationId: ctx.organizationId } },
      });
      if (existing) throw new TRPCError({ code: "CONFLICT", message: "User is already a member" });

      const member = await ctx.prisma.organizationMember.create({
        data: {
          userId: user.id,
          organizationId: ctx.organizationId,
          role: input.role,
        },
        include: { user: { select: { id: true, name: true, email: true, image: true } } },
      });

      // Fire-and-forget audit log
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.MEMBER_INVITED,
        entityType: "OrganizationMember",
        entityId: member.id,
        metadata: { email: input.email, role: input.role },
      }).catch(() => {});

      return member;
    }),

  updateRole: orgProcedure
    .input(z.object({ memberId: z.string(), role: z.enum(["ADMIN", "MEMBER", "VIEWER"]) }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role !== "OWNER") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only owners can change roles" });
      }
      const updated = await ctx.prisma.organizationMember.update({
        where: { id: input.memberId },
        data: { role: input.role },
      });

      // Fire-and-forget audit log
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.MEMBER_ROLE_CHANGED,
        entityType: "OrganizationMember",
        entityId: input.memberId,
        metadata: { memberId: input.memberId, newRole: input.role },
      }).catch(() => {});

      return updated;
    }),

  removeMember: orgProcedure
    .input(z.object({ memberId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role !== "OWNER" && ctx.membership.role !== "ADMIN") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const member = await ctx.prisma.organizationMember.findUnique({ where: { id: input.memberId } });
      if (member?.role === "OWNER") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot remove the owner" });
      }
      await ctx.prisma.organizationMember.delete({ where: { id: input.memberId } });

      // Fire-and-forget audit log
      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.MEMBER_REMOVED,
        entityType: "OrganizationMember",
        entityId: input.memberId,
      }).catch(() => {});

      return { success: true };
    }),
});
