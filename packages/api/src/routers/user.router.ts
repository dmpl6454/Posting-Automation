import { z } from "zod";
import { TRPCError } from "@trpc/server";
import bcrypt from "bcryptjs";
import { createRouter, protectedProcedure, adminProtectedProcedure } from "../trpc";
import { createRateLimitMiddleware } from "../middleware/rate-limit.middleware";
import {
  addPhoneOtpRateLimiter,
  addPhoneOtpPerPhoneLimiter,
  phoneRateLimitKey,
} from "../middleware/rate-limit";
import { sendSms } from "../lib/sms";
import { sendEmail } from "../lib/email";
import { phoneChangedEmail } from "../lib/email-templates";
import { createAuditLog, AUDIT_ACTIONS } from "../lib/audit";
import { PUBLIC_USER_SELECT } from "../lib/user-select";
import { verifyAndConsumePhoneOtp, PHONE_OTP_PURPOSE, DISCONNECTED_TOKEN } from "@postautomation/db";

export const userRouter = createRouter({
  me: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.prisma.user.findUnique({
      where: { id: (ctx.session.user as any).id },
      include: {
        memberships: {
          include: { organization: true },
          // S1: deterministic ordering so memberships[0] (the OrgSwitcher's
          // default) matches the server-side fallback in trpc.ts (orgProcedure)
          // and org.router (current). MemberRole is a Postgres enum, so role asc
          // sorts by declaration order (OWNER < ADMIN < MEMBER), preferring the
          // owned org; createdAt asc breaks ties to the oldest membership.
          // MUST stay identical to trpc.ts and org.router.
          orderBy: [{ role: "asc" }, { createdAt: "asc" }],
        },
      },
    });
    if (!user) return null;
    // Never the hash or the internal markers; apps/ios decodes the rest, so the
    // shape is otherwise unchanged.
    const { password, activeImpersonationJti: _jti, passwordChangedAt: _changed, ...rest } = user;
    return { ...rest, hasPassword: !!password };
  }),

  updateProfile: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).optional(),
        image: z.string().url().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = (ctx.session.user as any).id;
      // Explicit fields: a bare update returns the whole row, password hash included.
      const updated = await ctx.prisma.user.update({
        where: { id: userId },
        data: input,
        select: PUBLIC_USER_SELECT,
      });
      // Fix #78: audit log for profile update
      createAuditLog({
        userId,
        action: AUDIT_ACTIONS.USER_PROFILE_UPDATED,
        entityType: "User",
        entityId: userId,
        metadata: { fields: Object.keys(input) },
      }).catch((err) => {
        console.error("audit_log_write_failed", { err: err.message, action: AUDIT_ACTIONS.USER_PROFILE_UPDATED });
      });
      return updated;
    }),

  changePassword: protectedProcedure
    .input(
      z.object({
        currentPassword: z.string().optional(),
        newPassword: z.string().min(8),
        confirmPassword: z.string().min(8),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.newPassword !== input.confirmPassword) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "New passwords do not match",
        });
      }

      const user = await ctx.prisma.user.findUnique({
        where: { id: (ctx.session.user as any).id },
        select: { password: true },
      });

      if (!user) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      }

      // If user already has a password, require current password
      if (user.password) {
        if (!input.currentPassword) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Current password is required",
          });
        }
        const isValid = await bcrypt.compare(input.currentPassword, user.password);
        if (!isValid) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Current password is incorrect",
          });
        }
      }

      const hashedPassword = await bcrypt.hash(input.newPassword, 12);
      const userId = (ctx.session.user as any).id;
      await ctx.prisma.user.update({
        where: { id: userId },
        data: { password: hashedPassword },
      });

      // Fix #78: audit log for password change
      createAuditLog({
        userId,
        action: AUDIT_ACTIONS.USER_PASSWORD_CHANGED,
        entityType: "User",
        entityId: userId,
      }).catch((err) => {
        console.error("audit_log_write_failed", { err: err.message, action: AUDIT_ACTIONS.USER_PASSWORD_CHANGED });
      });

      return { success: true };
    }),

  /**
   * Self-service account deletion (App Store guideline 5.1.1(v), and the
   * promise on /data-deletion). Takes effect IMMEDIATELY for the account:
   *   - the User row is soft-deleted and its personal data wiped (email is
   *     replaced, so the address can sign up again), every session and OAuth
   *     link removed — the jwt callback already rejects a deletedAt user;
   *   - in workspaces where the user is the ONLY member: every channel is
   *     disconnected (tokens destroyed) and every SCHEDULED post cancelled, so
   *     nothing publishes after deletion. Those workspaces' posts and media are
   *     purged by an operator within 30 days (`user.account_deleted` audit
   *     entries list them) — a single cascading delete across 25+ relations
   *     is not something to run from a request handler;
   *   - in shared workspaces the user's membership is removed. Refused while
   *     the user is the only OWNER of a workspace that has other members.
   * Refused for super admins and while impersonating.
   */
  deleteAccount: protectedProcedure
    .input(z.object({ password: z.string().optional(), confirm: z.literal("DELETE") }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.isImpersonating) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Stop impersonating before deleting an account." });
      }
      const userId = (ctx.session.user as any).id as string;
      const user = await ctx.prisma.user.findUnique({
        where: { id: userId },
        select: {
          password: true,
          isSuperAdmin: true,
          deletedAt: true,
          memberships: {
            select: {
              role: true,
              organizationId: true,
              organization: {
                select: { name: true, members: { select: { userId: true, role: true } } },
              },
            },
          },
        },
      });
      if (!user || user.deletedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
      if (user.isSuperAdmin) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Super admin accounts can't be deleted from the app." });
      }
      if (user.password) {
        if (!input.password || !(await bcrypt.compare(input.password, user.password))) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Password is incorrect" });
        }
      }

      const plan = planAccountDeletion(userId, user.memberships);
      if (plan.blockedBy.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Transfer ownership of ${plan.blockedBy.join(", ")} to another member first — it has other members who still use it.`,
        });
      }

      const now = new Date();
      await ctx.prisma.$transaction(async (tx: any) => {
        if (plan.soloOrgIds.length > 0) {
          await tx.channel.updateMany({
            where: { organizationId: { in: plan.soloOrgIds }, disconnectedAt: null },
            data: { isActive: false, disconnectedAt: now, accessToken: DISCONNECTED_TOKEN, refreshToken: null },
          });
          await tx.postTarget.updateMany({
            where: { post: { organizationId: { in: plan.soloOrgIds } }, status: "SCHEDULED" },
            data: { status: "CANCELLED" },
          });
          await tx.post.updateMany({
            where: { organizationId: { in: plan.soloOrgIds }, status: "SCHEDULED" },
            data: { status: "CANCELLED" },
          });
        }
        await tx.organizationMember.deleteMany({ where: { userId } });
        await tx.session.deleteMany({ where: { userId } });
        await tx.account.deleteMany({ where: { userId } });
        await tx.user.update({
          where: { id: userId },
          data: {
            deletedAt: now,
            email: `deleted-${userId}@deleted.invalid`,
            name: null,
            image: null,
            password: null,
            phone: null,
            phoneVerified: null,
          },
          select: { id: true },
        });
      });

      createAuditLog({
        userId,
        action: AUDIT_ACTIONS.USER_ACCOUNT_DELETED,
        entityType: "User",
        entityId: userId,
        metadata: { purgeOrganizationIds: plan.soloOrgIds, leftOrganizationIds: plan.leftOrgIds },
      }).catch(() => {});

      return { success: true, workspacesClosed: plan.soloOrgIds.length };
    }),

  // 🔒 Rate limited (security audit 2026-09-28): sends a real SMS to any number.
  addPhone: protectedProcedure
    .use(createRateLimitMiddleware(addPhoneOtpRateLimiter))
    .input(z.object({ phone: z.string().min(7).max(20), currentPassword: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const userId = (ctx.session.user as any).id;

      // Security audit 2026-09-28: replacing an already-verified phone with a
      // DIFFERENT number used to need nothing but an active session — the
      // traced attack was a hijacked session attaching the attacker's own
      // phone as a durable second login method, invisible to the real owner.
      // Step-up is required only when actually CHANGING to a different
      // number; a first-time add or re-verifying the SAME number is
      // unaffected. Mirrors changePassword's own currentPassword check.
      const me = await ctx.prisma.user.findUnique({
        where: { id: userId },
        select: { phone: true, password: true },
      });
      if (me?.phone && me.phone !== input.phone) {
        if (!me.password) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Remove your existing phone number first (Settings) before adding a new one.",
          });
        }
        if (!input.currentPassword) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Current password is required to change your phone number.",
          });
        }
        const isValid = await bcrypt.compare(input.currentPassword, me.password);
        if (!isValid) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Current password is incorrect." });
        }
      }

      // Check if phone is already taken by another user
      const existing = await ctx.prisma.user.findUnique({
        where: { phone: input.phone },
        select: { id: true },
      });

      if (existing && existing.id !== userId) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This phone number is already linked to another account",
        });
      }

      // Per-number cap on top of the per-user one: many accounts can't each
      // send their 3/hour to the same stranger's phone.
      if (!addPhoneOtpPerPhoneLimiter(phoneRateLimitKey(input.phone)).success) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many codes sent to this number. Please try again later.",
        });
      }

      // Replace only the caller's own pending Settings code for this number —
      // not another user's, and not a login code.
      await ctx.prisma.phoneOtp.deleteMany({
        where: { phone: input.phone, userId, purpose: PHONE_OTP_PURPOSE.ADD_PHONE },
      });

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const hashedOtp = await bcrypt.hash(otp, 8);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await ctx.prisma.phoneOtp.create({
        data: { phone: input.phone, otp: hashedOtp, expiresAt, userId, purpose: PHONE_OTP_PURPOSE.ADD_PHONE },
      });

      await sendSms(
        input.phone,
        `Your PostAutomation verification code is: ${otp}. Valid for 10 minutes.`
      );

      return { success: true };
    }),

  verifyPhone: protectedProcedure
    .input(z.object({ phone: z.string(), otp: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = (ctx.session.user as any).id;

      // 🔒 Attempt-limited (security audit 2026-09-28) — see verify-phone-otp.ts.
      // Bound to a code THIS user requested via addPhone: otherwise a hijacked
      // session could redeem a code the attacker's own account requested and
      // attach that number without passing addPhone's step-up.
      const verified = await verifyAndConsumePhoneOtp(ctx.prisma as any, input.phone, input.otp, {
        userId,
        purpose: PHONE_OTP_PURPOSE.ADD_PHONE,
      });
      if (!verified.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            verified.reason === "locked"
              ? "Too many incorrect attempts. Please request a new code."
              : "Invalid or expired OTP. Please request a new one.",
        });
      }

      // Update user's phone and mark as verified. Two accounts can now hold
      // pending codes for the same unowned number (codes are per-user), so the
      // second verify can hit User.phone's unique constraint — say so plainly.
      let updated: { password: string | null };
      try {
        updated = await ctx.prisma.user.update({
          where: { id: userId },
          data: { phone: input.phone, phoneVerified: new Date() },
          select: { password: true },
        });
      } catch (err: any) {
        if (err?.code === "P2002") {
          throw new TRPCError({ code: "CONFLICT", message: "This phone number is already linked to another account" });
        }
        throw err;
      }

      // Fix #78: audit log for phone addition
      createAuditLog({
        userId,
        action: AUDIT_ACTIONS.USER_PHONE_ADDED,
        entityType: "User",
        entityId: userId,
      }).catch((err) => {
        console.error("audit_log_write_failed", { err: err.message, action: AUDIT_ACTIONS.USER_PHONE_ADDED });
      });

      // Security audit 2026-09-28: notify the account's REAL owner — sent to
      // ctx.session.user.email, which is always the account's registered
      // address regardless of which session (owner's or a hijacked one) is
      // currently acting as it, so it reaches the real owner even when a
      // phone was attached via a stolen session. Best-effort: a mail failure
      // must never fail the phone verification itself.
      const accountEmail = (ctx.session.user as any).email as string | undefined;
      if (accountEmail) {
        const emailContent = phoneChangedEmail(input.phone, { hasPassword: Boolean(updated?.password) });
        sendEmail({
          to: accountEmail,
          subject: emailContent.subject,
          html: emailContent.html,
          text: emailContent.text,
        }).catch((err: any) => {
          console.error("phone_change_email_failed", { err: err?.message });
        });
      }

      return { success: true };
    }),

  // Fix #95: phone removal requires OTP re-confirmation
  removePhone: protectedProcedure
    .input(z.object({ otp: z.string().length(6) }))
    .mutation(async ({ ctx, input }) => {
      const userId = (ctx.session.user as any).id;

      // Look up the user's current phone number
      const user = await ctx.prisma.user.findUnique({
        where: { id: userId },
        select: { phone: true },
      });
      if (!user?.phone) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No phone number to remove." });
      }

      // Verify OTP sent to this phone. Settings' "Remove Number" requests it via
      // addPhone with the same number, so it is this user's add-phone code.
      // 🔒 Attempt-limited (security audit 2026-09-28) — see verify-phone-otp.ts.
      const verifiedRemove = await verifyAndConsumePhoneOtp(ctx.prisma as any, user.phone, input.otp, {
        userId,
        purpose: PHONE_OTP_PURPOSE.ADD_PHONE,
      });
      if (!verifiedRemove.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            verifiedRemove.reason === "locked"
              ? "Too many incorrect attempts. Please request a new code."
              : "OTP not found or expired. Please request a new code.",
        });
      }

      await ctx.prisma.user.update({
        where: { id: userId },
        data: { phone: null, phoneVerified: null },
      });
      // Fix #78: audit log for phone removal
      createAuditLog({
        userId,
        action: AUDIT_ACTIONS.USER_PHONE_REMOVED,
        entityType: "User",
        entityId: userId,
      }).catch((err) => {
        console.error("audit_log_write_failed", { err: err.message, action: AUDIT_ACTIONS.USER_PHONE_REMOVED });
      });
      return { success: true };
    }),

  createOrganization: adminProtectedProcedure
    .input(
      z.object({ name: z.string().min(1), slug: z.string().optional() })
    )
    .mutation(async ({ ctx, input }) => {
      const rawSlug = (input.slug?.trim() || input.name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const slug = rawSlug || `org-${Date.now()}`;
      const org = await ctx.prisma.organization.create({
        data: {
          name: input.name,
          slug,
          members: {
            create: {
              userId: (ctx.session.user as any).id,
              role: "OWNER",
            },
          },
        },
      });
      return org;
    }),
});

/**
 * Pure: which workspaces an account deletion closes, leaves, or is blocked by.
 * A workspace is "solo" when the user is its only member. A shared workspace
 * blocks deletion when the user is its only OWNER (it would be left ownerless).
 */
export function planAccountDeletion(
  userId: string,
  memberships: Array<{
    role: string;
    organizationId: string;
    organization: { name: string; members: Array<{ userId: string; role: string }> };
  }>,
): { soloOrgIds: string[]; leftOrgIds: string[]; blockedBy: string[] } {
  const soloOrgIds: string[] = [];
  const leftOrgIds: string[] = [];
  const blockedBy: string[] = [];
  for (const m of memberships) {
    const others = m.organization.members.filter((x) => x.userId !== userId);
    if (others.length === 0) soloOrgIds.push(m.organizationId);
    else if (m.role === "OWNER" && !others.some((x) => x.role === "OWNER")) blockedBy.push(m.organization.name);
    else leftOrgIds.push(m.organizationId);
  }
  return { soloOrgIds, leftOrgIds, blockedBy };
}
