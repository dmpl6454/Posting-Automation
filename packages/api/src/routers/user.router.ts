import { z } from "zod";
import { TRPCError } from "@trpc/server";
import bcrypt from "bcryptjs";
import { createRouter, protectedProcedure } from "../trpc";
import { sendSms } from "../lib/sms";
import { createAuditLog, AUDIT_ACTIONS } from "../lib/audit";

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
    const { password, ...rest } = user;
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
      const updated = await ctx.prisma.user.update({
        where: { id: userId },
        data: input,
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

  addPhone: protectedProcedure
    .input(z.object({ phone: z.string().min(7).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const userId = (ctx.session.user as any).id;

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

      // Clean up old OTPs for this phone
      await ctx.prisma.phoneOtp.deleteMany({ where: { phone: input.phone } });

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const hashedOtp = await bcrypt.hash(otp, 8);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await ctx.prisma.phoneOtp.create({
        data: { phone: input.phone, otp: hashedOtp, expiresAt },
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

      const otpRecord = await ctx.prisma.phoneOtp.findFirst({
        where: {
          phone: input.phone,
          used: false,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
      });

      if (!otpRecord) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid or expired OTP. Please request a new one.",
        });
      }

      const isValid = await bcrypt.compare(input.otp, otpRecord.otp);
      if (!isValid) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Incorrect OTP. Please try again.",
        });
      }

      // Mark OTP as used
      await ctx.prisma.phoneOtp.update({
        where: { id: otpRecord.id },
        data: { used: true },
      });

      // Update user's phone and mark as verified
      await ctx.prisma.user.update({
        where: { id: userId },
        data: { phone: input.phone, phoneVerified: new Date() },
      });

      // Fix #78: audit log for phone addition
      createAuditLog({
        userId,
        action: AUDIT_ACTIONS.USER_PHONE_ADDED,
        entityType: "User",
        entityId: userId,
      }).catch((err) => {
        console.error("audit_log_write_failed", { err: err.message, action: AUDIT_ACTIONS.USER_PHONE_ADDED });
      });

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

      // Verify OTP sent to this phone
      const otpRecord = await ctx.prisma.phoneOtp.findFirst({
        where: {
          phone: user.phone,
          used: false,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
      });
      if (!otpRecord) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "OTP not found or expired. Please request a new code." });
      }
      const isValid = await bcrypt.compare(input.otp, otpRecord.otp);
      if (!isValid) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Incorrect OTP. Please try again." });
      }
      await ctx.prisma.phoneOtp.update({ where: { id: otpRecord.id }, data: { used: true } });

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

  createOrganization: protectedProcedure
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
