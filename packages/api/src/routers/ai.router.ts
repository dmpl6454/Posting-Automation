import { z } from "zod";
import { createRouter, orgProcedure } from "../trpc";
import { aiRateLimiter } from "../middleware/rate-limit";
import { createRateLimitMiddleware } from "../middleware/rate-limit.middleware";

const aiRateLimited = orgProcedure.use(createRateLimitMiddleware(aiRateLimiter));

export const aiRouter = createRouter({
  generateContent: aiRateLimited
    .input(
      z.object({
        prompt: z.string().min(1),
        platform: z.string().optional(),
        tone: z.enum(["professional", "casual", "humorous", "formal", "inspiring"]).default("professional"),
        provider: z.enum(["openai", "anthropic", "gemini"]).default("openai"),
      })
    )
    .mutation(async ({ input }) => {
      // Dynamically import to avoid issues if AI package isn't fully set up
      const { generateContent } = await import("@postautomation/ai");
      const content = await generateContent({
        provider: input.provider,
        platform: (input.platform || "TWITTER") as any,
        userPrompt: input.prompt,
        tone: input.tone,
      });
      return { content };
    }),

  suggestHashtags: aiRateLimited
    .input(z.object({ content: z.string().min(1), platform: z.string().optional() }))
    .mutation(async ({ input }) => {
      const { suggestHashtags } = await import("@postautomation/ai");
      const hashtags = await suggestHashtags({
        content: input.content,
        platform: input.platform || "TWITTER",
      });
      return { hashtags };
    }),

  optimizeContent: aiRateLimited
    .input(
      z.object({
        content: z.string().min(1),
        platform: z.string(),
        goal: z.enum(["engagement", "reach", "clicks", "conversions"]).default("engagement"),
      })
    )
    .mutation(async ({ input }) => {
      const { optimizeContent } = await import("@postautomation/ai");
      const optimized = await optimizeContent({
        content: input.content,
        platform: input.platform,
        goal: input.goal,
      });
      return { optimized };
    }),
});
