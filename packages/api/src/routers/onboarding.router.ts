import { createRouter, protectedProcedure } from "../trpc";
import { z } from "zod";
import { prisma } from "@postautomation/db";

const ONBOARDING_STEPS = ["profile", "organization", "channel", "first-post"] as const;

export const onboardingRouter = createRouter({
  getProgress: protectedProcedure.query(async ({ ctx }) => {
    const userId = (ctx.session.user as any).id as string;

    let progress = await prisma.onboardingProgress.findUnique({
      where: { userId },
    });

    if (!progress) {
      progress = await prisma.onboardingProgress.create({
        data: {
          userId,
          completedSteps: [],
          isComplete: false,
        },
      });
    }

    return progress;
  }),

  completeStep: protectedProcedure
    .input(
      z.object({
        step: z.enum(ONBOARDING_STEPS),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = (ctx.session.user as any).id as string;

      let progress = await prisma.onboardingProgress.findUnique({
        where: { userId },
      });

      if (!progress) {
        progress = await prisma.onboardingProgress.create({
          data: {
            userId,
            completedSteps: [],
            isComplete: false,
          },
        });
      }

      const completedSteps = progress.completedSteps as string[];
      if (!completedSteps.includes(input.step)) {
        completedSteps.push(input.step);
      }

      const isComplete = ONBOARDING_STEPS.every((s) =>
        completedSteps.includes(s)
      );

      const updated = await prisma.onboardingProgress.update({
        where: { userId },
        data: {
          completedSteps,
          isComplete,
        },
      });

      return updated;
    }),

  skip: protectedProcedure.mutation(async ({ ctx }) => {
    const userId = (ctx.session.user as any).id as string;

    const progress = await prisma.onboardingProgress.upsert({
      where: { userId },
      create: {
        userId,
        completedSteps: [],
        isComplete: true,
        skippedAt: new Date(),
      },
      update: {
        isComplete: true,
        skippedAt: new Date(),
      },
    });

    return progress;
  }),
});
