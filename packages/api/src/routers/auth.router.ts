import { z } from "zod";
import { TRPCError } from "@trpc/server";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { createRouter, publicProcedure, protectedProcedure } from "../trpc";
import { sendEmail } from "../lib/email";
import { passwordResetEmail, emailVerificationEmail } from "../lib/email-templates";
import { sendSms } from "../lib/sms";

export const authRouter = createRouter({
  requestPasswordReset: publicProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ ctx, input }) => {
      const normalizedEmail = input.email.toLowerCase().trim();
      const user = await ctx.prisma.user.findFirst({
        where: { email: { equals: normalizedEmail, mode: "insensitive" } },
        select: { id: true, email: true, isBanned: true, deletedAt: true, password: true },
      });

      // Always return success — never leak whether an email exists (privacy invariant)
      if (!user) return { success: true };

      // Don't issue a reset link for banned or deleted accounts — they can't log in anyway,
      // so sending a link just creates a confusing "I reset but still can't log in" loop.
      if (user.isBanned || user.deletedAt) return { success: true };

      // Only accounts with a password can use email/password reset.
      // OAuth-only users have no password to reset — return silently.
      if (!user.password) return { success: true };

      // Delete any existing reset tokens for this user
      await ctx.prisma.passwordResetToken.deleteMany({
        where: { userId: user.id },
      });

      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await ctx.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          token,
          expiresAt,
        },
      });

      // Send password reset email
      const appUrl = process.env.APP_URL || "http://localhost:3000";
      const resetUrl = `${appUrl}/reset-password?token=${token}`;
      const emailContent = passwordResetEmail(resetUrl);
      await sendEmail({
        to: user.email,
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text,
      });

      return { success: true };
    }),

  resetPassword: publicProcedure
    .input(
      z.object({
        token: z.string().min(1),
        password: z.string().min(8),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const resetToken = await ctx.prisma.passwordResetToken.findUnique({
        where: { token: input.token },
        include: { user: true },
      });

      if (!resetToken) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invalid or expired reset token",
        });
      }

      if (resetToken.expiresAt < new Date()) {
        // Clean up expired token
        await ctx.prisma.passwordResetToken.delete({
          where: { id: resetToken.id },
        });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Reset token has expired. Please request a new one.",
        });
      }

      const hashedPassword = await bcrypt.hash(input.password, 12);
      const now = new Date();

      await ctx.prisma.user.update({
        where: { id: resetToken.userId },
        data: {
          password: hashedPassword,
          // Stamp the change time — the JWT callback compares this against the
          // token's iat to invalidate any sessions that existed before the reset.
          passwordChangedAt: now,
        },
      });

      // Mark token as consumed (delete it — single-use enforced)
      await ctx.prisma.passwordResetToken.delete({
        where: { id: resetToken.id },
      });

      // Force-logout: delete any database sessions (covers non-JWT sessions / future changes)
      await ctx.prisma.session.deleteMany({
        where: { userId: resetToken.userId },
      });

      return { success: true };
    }),

  verifyEmail: publicProcedure
    .input(z.object({ token: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const verificationToken =
        await ctx.prisma.emailVerificationToken.findUnique({
          where: { token: input.token },
          include: { user: true },
        });

      if (!verificationToken) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Invalid or expired verification token",
        });
      }

      if (verificationToken.expiresAt < new Date()) {
        await ctx.prisma.emailVerificationToken.delete({
          where: { id: verificationToken.id },
        });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Verification token has expired. Please request a new one.",
        });
      }

      await ctx.prisma.user.update({
        where: { id: verificationToken.userId },
        data: { emailVerified: new Date() },
      });

      // Delete the used token
      await ctx.prisma.emailVerificationToken.delete({
        where: { id: verificationToken.id },
      });

      return { success: true };
    }),

  requestEmailVerification: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = (ctx.session.user as any).id;

    const user = await ctx.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
    }

    if (user.emailVerified) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Email is already verified",
      });
    }

    // Delete any existing verification tokens for this user
    await ctx.prisma.emailVerificationToken.deleteMany({
      where: { userId: user.id },
    });

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await ctx.prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        token,
        expiresAt,
      },
    });

    // Send verification email
    const appUrl = process.env.APP_URL || "http://localhost:3000";
    const verifyUrl = `${appUrl}/verify-email?token=${token}`;
    const emailContent = emailVerificationEmail(verifyUrl);
    await sendEmail({
      to: user.email,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
    });

    return { success: true };
  }),

  sendPhoneOtp: publicProcedure
    .input(z.object({ phone: z.string().min(7).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.prisma.user.findUnique({
        where: { phone: input.phone },
        select: { id: true, isBanned: true, phoneVerified: true },
      });

      // Always return success to avoid phone enumeration
      if (!user || !user.phoneVerified || user.isBanned) {
        return { success: true };
      }

      // Clean up old OTPs
      await ctx.prisma.phoneOtp.deleteMany({ where: { phone: input.phone } });

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const hashedOtp = await bcrypt.hash(otp, 8);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      await ctx.prisma.phoneOtp.create({
        data: { phone: input.phone, otp: hashedOtp, expiresAt },
      });

      await sendSms(
        input.phone,
        `Your PostAutomation login code is: ${otp}. Valid for 10 minutes. Do not share this code.`
      );

      return { success: true };
    }),
});
