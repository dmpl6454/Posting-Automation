import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "crypto";
import { createRouter, orgProcedure, publicProcedure, adminOrgProcedure } from "../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../lib/audit";
import { enforcePlanLimit } from "../middleware/plan-limit.middleware";
import { sendEmail } from "../lib/email";

export const teamRouter = createRouter({
  members: orgProcedure.query(async ({ ctx }) => {
    return ctx.prisma.organizationMember.findMany({
      where: { organizationId: ctx.organizationId },
      include: { user: { select: { id: true, name: true, email: true, image: true } } },
      orderBy: { createdAt: "asc" },
    });
  }),

  /**
   * Fix #69-71: Real email invite flow.
   * - Existing user AND already a member → CONFLICT
   * - Existing user AND not a member → add directly + send "you've been added" email
   * - No user with that email → create OrganizationInvite + send invite email
   */
  invite: adminOrgProcedure
    .input(z.object({ email: z.string().email(), role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER") }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role !== "OWNER" && ctx.membership.role !== "ADMIN") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only owners and admins can invite members" });
      }

      // Enforce plan limit for team members
      await enforcePlanLimit(ctx.organizationId, "teamMembers", ctx.isSuperAdmin);

      const org = await ctx.prisma.organization.findUnique({
        where: { id: ctx.organizationId },
        select: { name: true },
      });

      const user = await ctx.prisma.user.findFirst({
        where: { email: { equals: input.email.toLowerCase(), mode: "insensitive" } },
        select: { id: true, name: true, email: true },
      });

      if (user) {
        // Check if already a member
        const existing = await ctx.prisma.organizationMember.findUnique({
          where: { userId_organizationId: { userId: user.id, organizationId: ctx.organizationId } },
        });
        if (existing) {
          throw new TRPCError({ code: "CONFLICT", message: "User is already a member of this organization." });
        }

        // Add directly
        const member = await ctx.prisma.organizationMember.create({
          data: {
            userId: user.id,
            organizationId: ctx.organizationId,
            role: input.role,
          },
          include: { user: { select: { id: true, name: true, email: true, image: true } } },
        });

        // Send "you've been added" notification email
        await sendEmail({
          to: user.email,
          subject: `You've been added to ${org?.name ?? "an organization"} on PostAutomation`,
          html: `<p>Hi ${user.name ?? "there"},</p><p>You have been added to <strong>${org?.name}</strong> as <strong>${input.role}</strong>.</p><p><a href="${process.env.APP_URL}/dashboard">Go to your dashboard</a></p>`,
          text: `You have been added to ${org?.name} as ${input.role}. Visit: ${process.env.APP_URL}/dashboard`,
        }).catch(() => {}); // Non-blocking

        createAuditLog({
          organizationId: ctx.organizationId,
          userId: (ctx.session.user as any).id,
          action: AUDIT_ACTIONS.MEMBER_INVITED,
          entityType: "OrganizationMember",
          entityId: member.id,
          metadata: { email: input.email, role: input.role, method: "direct_add" },
        }).catch((err) => {
          console.error("audit_log_write_failed", { err: err.message, action: AUDIT_ACTIONS.MEMBER_INVITED });
        });

        return { status: "added", member };
      } else {
        // No user found — send an invite link
        const token = randomUUID();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        // Upsert: replace any existing pending invite for this email+org
        await ctx.prisma.organizationInvite.deleteMany({
          where: { organizationId: ctx.organizationId, email: input.email.toLowerCase(), acceptedAt: null },
        });

        await ctx.prisma.organizationInvite.create({
          data: {
            organizationId: ctx.organizationId,
            email: input.email.toLowerCase(),
            role: input.role,
            token,
            expiresAt,
            invitedById: (ctx.session.user as any).id,
          },
        });

        const inviteUrl = `${process.env.APP_URL}/invite/${token}`;

        await sendEmail({
          to: input.email,
          subject: `You're invited to join ${org?.name ?? "an organization"} on PostAutomation`,
          html: `<p>You've been invited to join <strong>${org?.name}</strong> as <strong>${input.role}</strong>.</p><p><a href="${inviteUrl}">Accept Invitation</a></p><p>This link expires in 7 days.</p>`,
          text: `You've been invited to join ${org?.name} as ${input.role}. Accept here: ${inviteUrl}`,
        }).catch(() => {}); // Non-blocking

        createAuditLog({
          organizationId: ctx.organizationId,
          userId: (ctx.session.user as any).id,
          action: AUDIT_ACTIONS.MEMBER_INVITED,
          entityType: "OrganizationInvite",
          entityId: token,
          metadata: { email: input.email, role: input.role, method: "email_invite" },
        }).catch((err) => {
          console.error("audit_log_write_failed", { err: err.message, action: AUDIT_ACTIONS.MEMBER_INVITED });
        });

        return { status: "invited", email: input.email };
      }
    }),

  /** Look up a pending invite by token — used by the accept-invite page */
  getInvite: publicProcedure
    .input(z.object({ token: z.string() }))
    .query(async ({ ctx, input }) => {
      const invite = await ctx.prisma.organizationInvite.findUnique({
        where: { token: input.token },
        include: { organization: { select: { id: true, name: true } } },
      });
      if (!invite) throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found or already used." });
      if (invite.expiresAt < new Date()) throw new TRPCError({ code: "BAD_REQUEST", message: "This invite link has expired." });
      if (invite.acceptedAt) throw new TRPCError({ code: "CONFLICT", message: "This invite has already been accepted." });
      return invite;
    }),

  /** Accept a pending invite — called from the /invite/[token] page */
  acceptInvite: publicProcedure
    .input(z.object({ token: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const sessionUserId = (ctx.session?.user as any)?.id as string | undefined;
      if (!sessionUserId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "You must be signed in to accept an invite." });
      }

      const invite = await ctx.prisma.organizationInvite.findUnique({
        where: { token: input.token },
      });
      if (!invite) throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found or already used." });
      if (invite.expiresAt < new Date()) throw new TRPCError({ code: "BAD_REQUEST", message: "This invite link has expired." });
      if (invite.acceptedAt) throw new TRPCError({ code: "CONFLICT", message: "This invite has already been accepted." });

      const user = await ctx.prisma.user.findUnique({ where: { id: sessionUserId }, select: { email: true } });
      if (!user) throw new TRPCError({ code: "UNAUTHORIZED" });

      // Verify the invite was sent to the signed-in user's email (case-insensitive)
      if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
        throw new TRPCError({ code: "FORBIDDEN", message: "This invite was sent to a different email address." });
      }

      // Add as member
      const existingMember = await ctx.prisma.organizationMember.findUnique({
        where: { userId_organizationId: { userId: sessionUserId, organizationId: invite.organizationId } },
      });
      if (!existingMember) {
        await ctx.prisma.organizationMember.create({
          data: { userId: sessionUserId, organizationId: invite.organizationId, role: invite.role },
        });
      }

      // Mark invite as accepted
      await ctx.prisma.organizationInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });

      return { organizationId: invite.organizationId };
    }),

  updateRole: adminOrgProcedure
    .input(z.object({ memberId: z.string(), role: z.enum(["ADMIN", "MEMBER"]) }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role !== "OWNER") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only owners can change roles" });
      }
      const target = await ctx.prisma.organizationMember.findFirst({
        where: { id: input.memberId, organizationId: ctx.organizationId },
      });
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found." });
      const updated = await ctx.prisma.organizationMember.update({
        where: { id: target.id },
        data: { role: input.role },
      });

      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.MEMBER_ROLE_CHANGED,
        entityType: "OrganizationMember",
        entityId: input.memberId,
        metadata: { memberId: input.memberId, newRole: input.role },
      }).catch((err) => {
        console.error("audit_log_write_failed", { err: err.message, action: AUDIT_ACTIONS.MEMBER_ROLE_CHANGED });
      });

      return updated;
    }),

  /**
   * Fix #72: Transfer ownership to another member.
   * The current owner is demoted to ADMIN and the target is promoted to OWNER.
   */
  transferOwnership: adminOrgProcedure
    .input(z.object({ newOwnerMemberId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role !== "OWNER") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the current owner can transfer ownership." });
      }

      const target = await ctx.prisma.organizationMember.findFirst({
        where: { id: input.newOwnerMemberId, organizationId: ctx.organizationId },
      });
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found." });
      if (target.id === ctx.membership.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "You are already the owner." });
      }

      await ctx.prisma.$transaction([
        // Demote current owner to ADMIN
        ctx.prisma.organizationMember.update({
          where: { id: ctx.membership.id },
          data: { role: "ADMIN" },
        }),
        // Promote target to OWNER
        ctx.prisma.organizationMember.update({
          where: { id: input.newOwnerMemberId },
          data: { role: "OWNER" },
        }),
      ]);

      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.MEMBER_ROLE_CHANGED,
        entityType: "Organization",
        entityId: ctx.organizationId,
        metadata: { from: ctx.membership.id, to: input.newOwnerMemberId, action: "ownership_transfer" },
      }).catch((err) => {
        console.error("audit_log_write_failed", { err: err.message, action: "ownership_transfer" });
      });

      return { success: true };
    }),

  removeMember: adminOrgProcedure
    .input(z.object({ memberId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.membership.role !== "OWNER" && ctx.membership.role !== "ADMIN") {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const member = await ctx.prisma.organizationMember.findFirst({
        where: { id: input.memberId, organizationId: ctx.organizationId },
      });
      if (!member) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found." });
      if (member.role === "OWNER") {
        // Fix #72: guard against orphaning the org
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot remove the owner. Transfer ownership first or delete the organization.",
        });
      }
      await ctx.prisma.organizationMember.delete({ where: { id: member.id } });

      createAuditLog({
        organizationId: ctx.organizationId,
        userId: (ctx.session.user as any).id,
        action: AUDIT_ACTIONS.MEMBER_REMOVED,
        entityType: "OrganizationMember",
        entityId: input.memberId,
      }).catch((err) => {
        console.error("audit_log_write_failed", { err: err.message, action: AUDIT_ACTIONS.MEMBER_REMOVED });
      });

      return { success: true };
    }),
});
