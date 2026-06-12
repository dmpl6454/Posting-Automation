import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import {
  generateImage,
  editImage,
  generateImageDallE,
  generateImageMeta,
} from "@postautomation/ai";
import { createRateLimitMiddleware } from "../middleware/rate-limit.middleware";
import { aiRateLimiter } from "../middleware/rate-limit";
import { uploadBase64ToS3 } from "../lib/s3";
import { mediaProcessQueue } from "@postautomation/queue";
import { enforcePlanLimit } from "../middleware/plan-limit.middleware";
import { toFriendlyAIError } from "../lib/ai-errors";

const aiRateLimited = orgProcedure.use(createRateLimitMiddleware(aiRateLimiter));

const imageProviderSchema = z
  .enum(["nano-banana", "nano-banana-pro", "dall-e", "meta-ai"])
  .optional()
  .default("nano-banana");

export const imageRouter = createRouter({
  // Generate a new image from a text prompt
  generate: aiRateLimited
    .input(
      z.object({
        prompt: z.string().min(1).max(2000),
        provider: imageProviderSchema,
        // Nano Banana options
        aspectRatio: z.string().optional().default("1:1"),
        imageSize: z.string().optional().default("1K"),
        model: z.enum(["gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview", "gemini-2.5-flash-image"]).optional(),
        // Reference images (design references, logos, etc.)
        referenceImages: z.array(z.object({
          base64: z.string(),
          mimeType: z.string().optional(),
        })).optional(),
        // DALL-E options
        size: z.enum(["1024x1024", "1024x1792", "1792x1024"]).optional(),
        quality: z.enum(["standard", "hd"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Enforce plan limit for AI images per month
      await enforcePlanLimit(ctx.organizationId, "aiImagesPerMonth", ctx.isSuperAdmin);

      try {
        if (input.provider === "dall-e") {
          // The UI sends `aspectRatio` (same field as the other providers) but
          // this branch only read `size` — which the UI never sends — so every
          // generation silently fell back to 1024x1024 square. Map the selected
          // ratio to the nearest gpt-image-1 size (it supports exactly three):
          // landscape → 1536x1024, portrait → 1024x1536, else square.
          let size = input.size as Parameters<typeof generateImageDallE>[0]["size"];
          if (!size && input.aspectRatio) {
            const [w, h] = input.aspectRatio.split(":").map(Number);
            const ratio = w && h ? w / h : 1;
            size = ratio > 1.15 ? "1536x1024" : ratio < 0.87 ? "1024x1536" : "1024x1024";
          }
          const result = await generateImageDallE({
            prompt: input.prompt,
            size,
            quality: input.quality,
          });

          return {
            imageBase64: result.imageBase64,
            mimeType: result.mimeType,
            description: result.text,
          };
        }

        if (input.provider === "meta-ai") {
          const result = await generateImageMeta({
            prompt: input.prompt,
            aspectRatio: input.aspectRatio,
          });
          return {
            imageBase64: result.imageBase64,
            mimeType: result.mimeType,
            description: undefined,
          };
        }

        // Nano Banana (default) and Nano Banana Pro
        const model =
          input.model ||
          (input.provider === "nano-banana-pro"
            ? "gemini-3-pro-image-preview"
            : undefined);

        const result = await generateImage({
          prompt: input.prompt,
          aspectRatio: input.aspectRatio,
          imageSize: input.imageSize,
          model,
          referenceImages: input.referenceImages,
        });

        return {
          imageBase64: result.imageBase64,
          mimeType: result.mimeType,
          description: result.text,
        };
      } catch (error: any) {
        console.error("[image.generate] Error:", error.message || error);
        // ADD-5: missing-key errors → friendly "AI Provider Not Configured"
        // (PRECONDITION_FAILED); other errors keep their message. Existing
        // TRPCErrors (e.g. the DALL-E edit BAD_REQUEST) pass through untouched.
        throw toFriendlyAIError(error);
      }
    }),

  // Edit an existing image using a text prompt
  edit: aiRateLimited
    .input(
      z.object({
        prompt: z.string().min(1).max(2000),
        imageBase64: z.string().min(1),
        imageMimeType: z.string().optional().default("image/jpeg"),
        provider: imageProviderSchema,
        model: z.enum(["gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview", "gemini-2.5-flash-image"]).optional(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        if (input.provider === "dall-e") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "DALL-E 3 does not support direct image editing. " +
              "Please use the Nano Banana provider for image editing, " +
              "or use the generate endpoint with DALL-E to create a new image from your prompt.",
          });
        }

        // Nano Banana (default) and Nano Banana Pro
        const model =
          input.model ||
          (input.provider === "nano-banana-pro"
            ? "gemini-3-pro-image-preview"
            : undefined);

        const result = await editImage({
          prompt: input.prompt,
          imageBase64: input.imageBase64,
          imageMimeType: input.imageMimeType,
          model,
        });

        return {
          imageBase64: result.imageBase64,
          mimeType: result.mimeType,
          description: result.text,
        };
      } catch (error: any) {
        // toFriendlyAIError re-throws existing TRPCErrors untouched and maps
        // missing-key errors to a friendly PRECONDITION_FAILED (ADD-5).
        throw toFriendlyAIError(error);
      }
    }),

  // Upload a generated image to S3 and create a media record
  saveGenerated: orgProcedure
    .input(
      z.object({
        imageBase64: z.string().min(1),
        mimeType: z.string().default("image/png"),
        fileName: z.string().default("generated-image.png"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = (ctx.session.user as any).id;

      // Derive file extension from mime type
      const extMap: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
      };
      const ext = extMap[input.mimeType] || "png";

      // Generate a unique S3 key
      const timestamp = Date.now();
      const random = Math.random().toString(36).slice(2);
      const s3Key = `${ctx.organizationId}/ai-generated/${timestamp}-${random}.${ext}`;

      // Compute approximate file size from base64 length
      const fileSize = Math.ceil((input.imageBase64.length * 3) / 4);

      // Upload the base64 image to S3
      const publicUrl = await uploadBase64ToS3({
        base64: input.imageBase64,
        mimeType: input.mimeType,
        key: s3Key,
      });

      // Create the Media record with the real S3 URL
      const media = await ctx.prisma.media.create({
        data: {
          organizationId: ctx.organizationId,
          uploadedById: userId,
          fileName: input.fileName,
          fileType: input.mimeType,
          fileSize,
          url: publicUrl,
        },
      });

      // Enqueue a background job to generate a thumbnail
      await mediaProcessQueue.add(
        `media-thumbnail-${media.id}`,
        {
          mediaId: media.id,
          organizationId: ctx.organizationId,
          operation: "thumbnail",
        },
        { attempts: 3, backoff: { type: "exponential", delay: 2000 } }
      );

      return {
        id: media.id,
        url: publicUrl,
        fileName: input.fileName,
        mimeType: input.mimeType,
      };
    }),
});
