import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, superAdminProcedure } from "../../trpc";
import { createAuditLog, AUDIT_ACTIONS } from "../../lib/audit";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: process.env.AWS_ACCESS_KEY_ID
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      }
    : undefined,
});

export const adminMediaRouter = createRouter({
  list: superAdminProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { limit, cursor } = input;

      const items = await ctx.prisma.media.findMany({
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: {
          organization: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      let nextCursor: string | undefined;
      if (items.length > limit) {
        const next = items.pop()!;
        nextCursor = next.id;
      }

      return { items, nextCursor };
    }),

  storageStats: superAdminProcedure.query(async ({ ctx }) => {
    const [totalCount, byMimeType, byOrg] = await Promise.all([
      ctx.prisma.media.count(),
      ctx.prisma.media.groupBy({
        by: ["fileType"],
        _count: { id: true },
        _sum: { fileSize: true },
      }),
      ctx.prisma.media.groupBy({
        by: ["organizationId"],
        _count: { id: true },
        _sum: { fileSize: true },
      }),
    ]);

    // Resolve org names
    const orgIds = byOrg.map((g) => g.organizationId);
    const orgs = await ctx.prisma.organization.findMany({
      where: { id: { in: orgIds } },
      select: { id: true, name: true },
    });
    const orgMap = new Map(orgs.map((o) => [o.id, o.name]));

    return {
      totalCount,
      byMimeType: byMimeType.map((g) => ({
        mimeType: g.fileType,
        count: g._count.id,
        totalSize: g._sum.fileSize ?? 0,
      })),
      byOrganization: byOrg.map((g) => ({
        organizationId: g.organizationId,
        organizationName: orgMap.get(g.organizationId) ?? "Unknown",
        count: g._count.id,
        totalSize: g._sum.fileSize ?? 0,
      })),
    };
  }),

  delete: superAdminProcedure
    .input(z.object({ mediaId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const media = await ctx.prisma.media.findUnique({
        where: { id: input.mediaId },
      });
      if (!media) throw new TRPCError({ code: "NOT_FOUND" });

      // Extract S3 key from URL
      try {
        const url = new URL(media.url);
        const key = url.pathname.startsWith("/")
          ? url.pathname.slice(1)
          : url.pathname;
        const bucket = process.env.AWS_S3_BUCKET;

        if (bucket && key) {
          await s3.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: key })
          );
        }
      } catch {
        // S3 deletion failure shouldn't block DB cleanup
        console.error("Failed to delete S3 object for media:", input.mediaId);
      }

      await ctx.prisma.media.delete({ where: { id: input.mediaId } });

      createAuditLog({
        userId: (ctx.session.user as any).id,
        organizationId: media.organizationId,
        action: AUDIT_ACTIONS.ADMIN_MEDIA_DELETED,
        entityType: "Media",
        entityId: input.mediaId,
      }).catch(() => {});

      return { success: true };
    }),
});
