import { z } from "zod";
import { TRPCError } from "@trpc/server";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { createRouter, publicProcedure, protectedProcedure } from "../trpc";
import { sendEmail } from "../lib/email";
import { passwordResetEmail, emailVerificationEmail } from "../lib/email-templates";

export const authRouter = createRouter({
  requestPasswordReset: publicProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.prisma.user.findUnique({
        where: { email: input.email },
      });

      // Always return success to avoid email enumeration
      if (!user) {
        return { success: true };
      }

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

      await ctx.prisma.user.update({
        where: { id: resetToken.userId },
        data: { password: hashedPassword },
      });

      // Delete the used token
      await ctx.prisma.passwordResetToken.delete({
        where: { id: resetToken.id },
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
});
