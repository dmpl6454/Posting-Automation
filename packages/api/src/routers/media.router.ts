import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createRouter, orgProcedure } from "../trpc";
import { getS3Client, BUCKET, getPublicUrl } from "../lib/s3";

const MAX_IMAGE_SIZE = 50 * 1024 * 1024;  // 50MB for images
const MAX_VIDEO_SIZE = 500 * 1024 * 1024; // 500MB for videos
const MAX_FILE_SIZE = MAX_VIDEO_SIZE;
const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
];

export const mediaRouter = createRouter({
  list: orgProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
        type: z.enum(["image", "video", "all"]).default("all"),
      })
    )
    .query(async ({ ctx, input }) => {
      const where: any = { organizationId: ctx.organizationId };
      if (input.type === "image") {
        where.fileType = { startsWith: "image/" };
      } else if (input.type === "video") {
        where.fileType = { startsWith: "video/" };
      }

      const items = await ctx.prisma.media.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      });

      let nextCursor: string | undefined;
      if (items.length > input.limit) {
        const last = items.pop();
        nextCursor = last?.id;
      }

      return { items, nextCursor };
    }),

  getUploadUrl: orgProcedure
    .input(
      z.object({
        fileName: z.string().min(1).max(255),
        fileType: z.string(),
        fileSize: z.number().min(1).max(MAX_FILE_SIZE),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Validate file type
      if (!ALLOWED_TYPES.includes(input.fileType)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `File type '${input.fileType}' is not allowed. Supported: ${ALLOWED_TYPES.join(", ")}`,
        });
      }

      // Per-type size validation
      const isVideo = input.fileType.startsWith("video/");
      const sizeLimit = isVideo ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE;
      if (input.fileSize > sizeLimit) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `File too large. ${isVideo ? "Videos" : "Images"} must be under ${isVideo ? "500MB" : "50MB"}.`,
        });
      }

      // Generate unique S3 key
      const ext = input.fileName.split(".").pop() || "bin";
      const key = `${ctx.organizationId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

      // Generate presigned PUT URL
      const s3 = getS3Client();
      const command = new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: input.fileType,
        ContentLength: input.fileSize,
      });

      const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });

      // Construct the public URL for accessing the file after upload
      const publicUrl = getPublicUrl(key);

      // Create media record in DB
      const media = await ctx.prisma.media.create({
        data: {
          organizationId: ctx.organizationId,
          uploadedById: (ctx.session.user as any).id,
          fileName: input.fileName,
          fileType: input.fileType,
          fileSize: input.fileSize,
          url: publicUrl,
        },
      });

      return {
        uploadUrl,
        publicUrl,
        mediaId: media.id,
        key,
      };
    }),

  confirmUpload: orgProcedure
    .input(z.object({ mediaId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const media = await ctx.prisma.media.findFirst({
        where: { id: input.mediaId, organizationId: ctx.organizationId },
      });
      if (!media) throw new TRPCError({ code: "NOT_FOUND" });

      // Mark as confirmed/ready (could add a status field later)
      return { success: true, media };
    }),

  delete: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const media = await ctx.prisma.media.findFirst({
        where: { id: input.id, organizationId: ctx.organizationId },
      });
      if (!media) throw new TRPCError({ code: "NOT_FOUND" });

      // Delete from S3
      try {
        const s3 = getS3Client();
        const key = media.url.split(`${BUCKET}/`).pop();
        if (key) {
          await s3.send(
            new DeleteObjectCommand({
              Bucket: BUCKET,
              Key: key,
            })
          );
        }
      } catch (err) {
        console.error("Failed to delete from S3:", err);
        // Continue with DB deletion even if S3 fails
      }

      await ctx.prisma.media.delete({ where: { id: input.id } });
      return { success: true };
    }),
});
