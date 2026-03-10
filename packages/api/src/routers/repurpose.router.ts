import { z } from "zod";
import { createRouter, protectedProcedure } from "../trpc";

export const repurposeRouter = createRouter({
  repurpose: protectedProcedure
    .input(
      z.object({
        originalContent: z.string().min(1).max(50000),
        targetPlatforms: z.array(z.string()).min(1).max(16),
        provider: z.enum(["openai", "anthropic"]).default("openai"),
      })
    )
    .mutation(async ({ input }) => {
      const { repurposeContent } = await import("@postautomation/ai");
      const result = await repurposeContent({
        originalContent: input.originalContent,
        targetPlatforms: input.targetPlatforms,
        provider: input.provider,
      });
      return { platformContent: result };
    }),
});
