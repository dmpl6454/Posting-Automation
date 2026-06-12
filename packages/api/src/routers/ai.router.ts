import { z } from "zod";
import { createRouter, orgProcedure } from "../trpc";
import { aiRateLimiter } from "../middleware/rate-limit";
import { createRateLimitMiddleware } from "../middleware/rate-limit.middleware";
import { toFriendlyAIError } from "../lib/ai-errors";

const aiRateLimited = orgProcedure.use(createRateLimitMiddleware(aiRateLimiter));

export const aiRouter = createRouter({
  generateContent: aiRateLimited
    .input(
      z.object({
        prompt: z.string().min(1),
        platform: z.string().optional(),
        tone: z.enum(["professional", "casual", "humorous", "formal", "inspiring"]).default("professional"),
        provider: z.enum(["openai", "anthropic", "gemini", "grok", "deepseek", "gemma4"]).default("openai"),
      })
    )
    .mutation(async ({ input }) => {
      try {
        // Dynamically import to avoid issues if AI package isn't fully set up
        const { generateContent, withTextProviderFallback } = await import("@postautomation/ai");
        // Resilient chain [chosen → openai → anthropic]: a billing-held or
        // quota-exhausted chosen provider degrades to the next configured one
        // instead of hard-failing the generation (same policy as repurpose).
        const content = await withTextProviderFallback(
          input.provider,
          (p) =>
            generateContent({
              provider: p as typeof input.provider,
              platform: (input.platform || "TWITTER") as any,
              userPrompt: input.prompt,
              tone: input.tone,
            }),
          (failed, next, err) =>
            console.warn(`[AI] generateContent via ${failed} failed (${err instanceof Error ? err.message.slice(0, 80) : err}), trying ${next}`),
        );
        return { content };
      } catch (e) {
        // ADD-5: surface missing-key errors as a friendly "AI Provider Not
        // Configured" instead of a raw HTTP 500 leaking the env-var name.
        throw toFriendlyAIError(e);
      }
    }),

  suggestHashtags: aiRateLimited
    .input(z.object({ content: z.string().min(1), platform: z.string().optional() }))
    .mutation(async ({ input }) => {
      try {
        const { suggestHashtags, withTextProviderFallback } = await import("@postautomation/ai");
        const hashtags = await withTextProviderFallback(
          undefined, // default chain [openai → anthropic]
          (p) =>
            suggestHashtags({
              content: input.content,
              platform: input.platform || "TWITTER",
              provider: p as any,
            }),
          (failed, next, err) =>
            console.warn(`[AI] suggestHashtags via ${failed} failed (${err instanceof Error ? err.message.slice(0, 80) : err}), trying ${next}`),
        );
        return { hashtags };
      } catch (e) {
        throw toFriendlyAIError(e);
      }
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
      try {
        const { optimizeContent, withTextProviderFallback } = await import("@postautomation/ai");
        const optimized = await withTextProviderFallback(
          undefined, // default chain [openai → anthropic]
          (p) =>
            optimizeContent({
              content: input.content,
              platform: input.platform,
              goal: input.goal,
              provider: p as any,
            } as any),
          (failed, next, err) =>
            console.warn(`[AI] optimizeContent via ${failed} failed (${err instanceof Error ? err.message.slice(0, 80) : err}), trying ${next}`),
        );
        return { optimized };
      } catch (e) {
        throw toFriendlyAIError(e);
      }
    }),

  /** Returns which AI providers are configured (have a non-empty API key).
   *  Single source of truth for all provider-gating UI across the app.
   */
  getConfig: orgProcedure.query(() => {
    const googleKey = !!(process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY);

    // Text / chat providers
    const openai    = !!process.env.OPENAI_API_KEY;
    const anthropic = !!process.env.ANTHROPIC_API_KEY;
    const gemini    = googleKey;
    const gemma4    = googleKey;   // same Google key as Gemini
    const grok      = !!process.env.XAI_API_KEY;
    const deepseek  = !!process.env.DEEPSEEK_API_KEY;

    // Image generation providers
    const imageNanoBanana = googleKey;   // Nano Banana 2 / Pro
    const imageDalle      = openai;      // DALL-E 3
    const imageMeta       = !!process.env.TOGETHER_API_KEY;   // FLUX.1

    // Video generation providers
    const videoVeo      = googleKey;     // Veo 3
    const videoSeedance = !!(process.env.FAL_KEY || process.env.FAL_API_KEY);  // Seedance 2.0

    // Convenience flags
    const anyTextConfigured  = openai || anthropic || gemini || gemma4 || grok || deepseek;
    const anyImageConfigured = imageNanoBanana || imageDalle || imageMeta;
    const anyVideoConfigured = videoVeo || videoSeedance;
    const anyConfigured      = anyTextConfigured;

    return {
      // Text providers
      openai, anthropic, gemini, gemma4, grok, deepseek,
      // Image providers
      imageNanoBanana, imageDalle, imageMeta,
      // Video providers
      videoVeo, videoSeedance,
      // Convenience
      anyConfigured, anyTextConfigured, anyImageConfigured, anyVideoConfigured,
    };
  }),
});
