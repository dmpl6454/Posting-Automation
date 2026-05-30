import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createRouter, orgProcedure } from "../trpc";
import { getS3Client, getS3PresignClient, BUCKET, getPublicUrl } from "../lib/s3";

const MAX_IMAGE_SIZE = 50 * 1024 * 1024;          // 50MB
const MAX_VIDEO_SIZE = 5 * 1024 * 1024 * 1024;    // 5GB (was 500MB single-part; multipart can go much larger)
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);

// Part URLs expire after 1h — plenty for even very large uploads at typical speeds
const PART_URL_EXPIRES_IN = 60 * 60;

export const uploadRouter = createRouter({
  /**
   * Begin a multipart upload. Returns the S3 uploadId + key the client must
   * use for every part. The file is NOT created in the Media table yet —
   * that happens in `complete` once every part is in.
   */
  initiate: orgProcedure
    .input(
      z.object({
        fileName: z.string().min(1).max(500),
        fileType: z.string().min(1).max(200),
        fileSize: z.number().int().positive(),
        category: z.string().max(50).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!ALLOWED_TYPES.has(input.fileType)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `File type '${input.fileType}' is not allowed` });
      }
      const isVideo = input.fileType.startsWith("video/");
      const sizeLimit = isVideo ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE;
      if (input.fileSize > sizeLimit) {
        const limitMB = isVideo ? "5,120" : "50";
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `File too large. ${isVideo ? "Videos" : "Images"} must be under ${limitMB} MB.`,
        });
      }

      const ext = input.fileName.split(".").pop()?.replace(/[^a-zA-Z0-9]/g, "") || "bin";
      const key = `${ctx.organizationId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

      const s3 = getS3Client();
      const res = await s3.send(
        new CreateMultipartUploadCommand({
          Bucket: BUCKET,
          Key: key,
          ContentType: input.fileType,
        })
      );
      if (!res.UploadId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "S3 did not return an UploadId" });
      }
      return {
        uploadId: res.UploadId,
        key,
        bucket: BUCKET,
      };
    }),

  /**
   * Mint a presigned PUT URL for a single part. The client will PUT the part
   * bytes directly to S3/MinIO without proxying through this server.
   */
  signPart: orgProcedure
    .input(
      z.object({
        key: z.string().min(1),
        uploadId: z.string().min(1),
        partNumber: z.number().int().min(1).max(10_000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Org-scope check: key must start with `${organizationId}/`
      if (!input.key.startsWith(`${ctx.organizationId}/`)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Upload key does not belong to your organization" });
      }
      // Use the presign client — its endpoint must be browser-reachable
      // (e.g. https://postautomation.co.in/media in prod, http://localhost:9000 locally).
      const s3 = getS3PresignClient();
      const url = await getSignedUrl(
        s3,
        new UploadPartCommand({
          Bucket: BUCKET,
          Key: input.key,
          UploadId: input.uploadId,
          PartNumber: input.partNumber,
        }),
        { expiresIn: PART_URL_EXPIRES_IN }
      );
      return { url };
    }),

  /**
   * Finalize the multipart upload and persist the Media row. Client passes
   * the ETag returned by S3 for each part PUT in order.
   */
  complete: orgProcedure
    .input(
      z.object({
        key: z.string().min(1),
        uploadId: z.string().min(1),
        parts: z
          .array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1) }))
          .min(1)
          .max(10_000),
        fileName: z.string().min(1).max(500),
        fileType: z.string().min(1).max(200),
        fileSize: z.number().int().positive(),
        category: z.string().max(50).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!input.key.startsWith(`${ctx.organizationId}/`)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Upload key does not belong to your organization" });
      }
      const s3 = getS3Client();
      try {
        await s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: BUCKET,
            Key: input.key,
            UploadId: input.uploadId,
            MultipartUpload: {
              Parts: input.parts
                .slice()
                .sort((a, b) => a.partNumber - b.partNumber)
                .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
            },
          })
        );
      } catch (err: any) {
        // If finalize fails, abort to free the in-progress parts on S3
        try {
          await s3.send(
            new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: input.key, UploadId: input.uploadId })
          );
        } catch {}
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to finalize upload: ${err?.message ?? "unknown S3 error"}`,
        });
      }

      const publicUrl = getPublicUrl(input.key);

      const media = await ctx.prisma.media.create({
        data: {
          organizationId: ctx.organizationId,
          uploadedById: (ctx.session.user as any).id,
          fileName: input.fileName,
          fileType: input.fileType,
          fileSize: input.fileSize,
          url: publicUrl,
          ...(input.category && input.category !== "general" ? { category: input.category } : {}),
        },
      });

      return {
        id: media.id,
        url: publicUrl,
        fileName: input.fileName,
        fileType: input.fileType,
      };
    }),

  /**
   * Cancel an in-progress upload. Frees server-side multipart state.
   */
  abort: orgProcedure
    .input(z.object({ key: z.string().min(1), uploadId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (!input.key.startsWith(`${ctx.organizationId}/`)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Upload key does not belong to your organization" });
      }
      const s3 = getS3Client();
      await s3
        .send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: input.key, UploadId: input.uploadId }))
        .catch(() => {});
      return { success: true };
    }),
});
