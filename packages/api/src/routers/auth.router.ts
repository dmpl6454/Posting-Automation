import { z } from "zod";
import { TRPCError } from "@trpc/server";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { createRouter, publicProcedure, protectedProcedure } from "../trpc";
import { sendEmail } from "../lib/email";
import { passwordResetEmail, emailVerificationEmail } from "../lib/email-templates";
import { sendSms } from "../lib/sms";
import { loginOtpPerPhoneLimiter, phoneRateLimitKey } from "../middleware/rate-limit";
import { PHONE_OTP_PURPOSE } from "@postautomation/db";

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
          // Security audit 2026-09-28: a phone number could be attached as a
          // second login method with nothing but a hijacked session (now
          // gated — see user.router.ts addPhone), and it survived untouched
          // through a password reset, so the attacker could still sign in via
          // phone-otp afterward. Clearing it here treats the phone login
          // method as part of the credential set this reset invalidates,
          // exactly like the password itself — any phone attached before the
          // reset, attacker's or the owner's own, requires re-verification.
          phone: null,
          phoneVerified: null,
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

      // Lets the success screen say phone sign-in was removed, only when it was.
      return { success: true, phoneRemoved: Boolean(resetToken.user?.phone) };
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
      // Fix #19: surface missing SMS configuration before attempting to send
      const smsConfigured =
        (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) ||
        process.env.FAST2SMS_API_KEY;
      if (!smsConfigured) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "SMS service is not configured. Please use email login or contact support.",
        });
      }

      const user = await ctx.prisma.user.findUnique({
        where: { phone: input.phone },
        select: { id: true, isBanned: true, phoneVerified: true },
      });

      // Always return success to avoid phone enumeration
      if (!user || !user.phoneVerified || user.isBanned) {
        return { success: true };
      }

      // Per-phone issuance cap — each send resets the attempt counter, so this
      // is what bounds total guesses. Counted only for real verified numbers
      // (bounded key set); over the cap stays silent to avoid enumeration.
      if (!loginOtpPerPhoneLimiter(phoneRateLimitKey(input.phone)).success) {
        return { success: true };
      }

      // Clean up old LOGIN codes only — never the owner's in-flight Settings code.
      await ctx.prisma.phoneOtp.deleteMany({
        where: { phone: input.phone, purpose: PHONE_OTP_PURPOSE.LOGIN },
      });

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const hashedOtp = await bcrypt.hash(otp, 8);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      await ctx.prisma.phoneOtp.create({
        data: {
          phone: input.phone,
          otp: hashedOtp,
          expiresAt,
          userId: user.id,
          purpose: PHONE_OTP_PURPOSE.LOGIN,
        },
      });

      await sendSms(
        input.phone,
        `Your PostAutomation login code is: ${otp}. Valid for 10 minutes. Do not share this code.`
      );

      return { success: true };
    }),
});
