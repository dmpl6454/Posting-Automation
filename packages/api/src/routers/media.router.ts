import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createRouter, orgProcedure } from "../trpc";
import { getS3Client, BUCKET } from "../lib/s3";

// Upload size and type limits live in upload.router.ts (the presigned multipart
// path every upload uses). The copies that were here served only the removed
// media.getUploadUrl route (security audit 2026-09-28).

export const mediaRouter = createRouter({
  list: orgProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(40),
        cursor: z.string().optional(),
        type: z.enum(["image", "video", "all"]).default("all"),
        search: z.string().max(200).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const where: any = { organizationId: ctx.organizationId };
      if (input.type === "image") {
        where.fileType = { startsWith: "image/" };
      } else if (input.type === "video") {
        where.fileType = { startsWith: "video/" };
      }
      if (input.search) {
        where.fileName = { contains: input.search, mode: "insensitive" };
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

  /**
   * Resolve already-uploaded media URLs to their owning Media row ids, org-scoped.
   *
   * Used by ComposeTab when a `postMedia` item carries only a `url` (e.g. a
   * Repurpose "Create Post" deep link `?aiImage=<url>` that arrived WITHOUT
   * `aiMediaId`). Before this, such items were silently dropped at create time
   * (the create handlers persisted only `mediaId`/`file`), producing a post with
   * NO image while the preview still showed it. Resolving the URL back to its
   * existing Media id is lossless (no re-download/re-upload) and org-scoped, so
   * it can't leak another org's media. URLs that don't resolve are simply omitted
   * from the returned map — the caller decides whether to fall back or block.
   */
  resolveByUrl: orgProcedure
    .input(z.object({ urls: z.array(z.string()).min(1).max(20) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.prisma.media.findMany({
        where: { organizationId: ctx.organizationId, url: { in: input.urls } },
        select: { id: true, url: true },
      });
      // url -> mediaId (org-owned only). Missing urls are absent from the map.
      const map: Record<string, string> = {};
      for (const r of rows) map[r.url] = r.id;
      return { map };
    }),

  /**
   * Org-scoped existence check for a set of Media ids. Used by ComposeTab's
   * draft restore to reconcile up-to-24h-old drafts against the live library —
   * a since-deleted id would otherwise fail the ENTIRE post.create at submit
   * (assertMediaOwned rejects on any unknown id).
   */
  verifyIds: orgProcedure
    .input(z.object({ ids: z.array(z.string()).min(1).max(50) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.prisma.media.findMany({
        where: { id: { in: input.ids }, organizationId: ctx.organizationId },
        select: { id: true },
      });
      return { ownedIds: rows.map((r) => r.id) };
    }),

  // 🔒 media.getUploadUrl was REMOVED (security audit 2026-09-28). Its presigned
  // PUT could not bind Content-Type (the presigner treats it as unsignable), it
  // took the key's file extension from the client's filename, and it created the
  // Media row before anything was uploaded — so any user could store HTML under
  // an .html key on our own origin. Nothing in the UI called it. All uploads go
  // through upload.initiate/signPart/complete, which fixes the type server-side
  // and HEADs the object before registering it.

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
