import { z } from "zod";
import { createRouter, protectedProcedure } from "../trpc";
import { prisma } from "@postautomation/db";
import { TRPCError } from "@trpc/server";

export const bulkRouter = createRouter({
  /**
   * Schedule multiple posts at once.
   * Updates each post's scheduledAt and sets status to SCHEDULED.
   */
  bulkSchedule: protectedProcedure
    .input(
      z.object({
        items: z
          .array(
            z.object({
              postId: z.string(),
              scheduledAt: z.string(),
            })
          )
          .min(1)
          .max(100),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.organizationId as string;
      if (!organizationId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Organization ID required" });
      }

      let scheduled = 0;

      for (const item of input.items) {
        const post = await prisma.post.findFirst({
          where: { id: item.postId, organizationId },
        });
        if (!post) continue;

        await prisma.post.update({
          where: { id: item.postId },
          data: {
            scheduledAt: new Date(item.scheduledAt),
            status: "SCHEDULED",
          },
        });
        scheduled++;
      }

      return { scheduled };
    }),

  /**
   * Delete multiple posts that belong to the organization.
   */
  bulkDelete: protectedProcedure
    .input(
      z.object({
        postIds: z.array(z.string()).min(1).max(100),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.organizationId as string;
      if (!organizationId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Organization ID required" });
      }

      const result = await prisma.post.deleteMany({
        where: {
          id: { in: input.postIds },
          organizationId,
        },
      });

      return { deleted: result.count };
    }),

  /**
   * Change the status of multiple posts to DRAFT or CANCELLED.
   */
  bulkUpdateStatus: protectedProcedure
    .input(
      z.object({
        postIds: z.array(z.string()).min(1).max(100),
        status: z.enum(["DRAFT", "CANCELLED"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.organizationId as string;
      if (!organizationId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Organization ID required" });
      }

      const result = await prisma.post.updateMany({
        where: {
          id: { in: input.postIds },
          organizationId,
        },
        data: {
          status: input.status,
        },
      });

      return { updated: result.count };
    }),

  /**
   * Import posts from CSV data.
   * Expects first row to be headers: "content", optional "scheduledAt".
   * Creates Post records and links them to specified channels via PostTarget.
   */
  csvImport: protectedProcedure
    .input(
      z.object({
        csvData: z.string().min(1),
        channelIds: z.array(z.string()).min(1),
        scheduledAt: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = ctx.organizationId as string;
      if (!organizationId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Organization ID required" });
      }

      const lines = input.csvData.split("\n").filter((line) => line.trim() !== "");
      if (lines.length < 2) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "CSV must have a header row and at least one data row",
        });
      }

      // Parse header row
      const headers = parseCSVRow(lines[0] as string).map((h) => h.trim().toLowerCase());
      const contentIdx = headers.indexOf("content");
      if (contentIdx === -1) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: 'CSV must have a "content" column',
        });
      }
      const scheduledAtIdx = headers.indexOf("scheduledat");

      // Validate channels belong to the org
      const channels = await prisma.channel.findMany({
        where: {
          id: { in: input.channelIds },
          organizationId,
        },
        select: { id: true },
      });
      const validChannelIds = channels.map((c) => c.id);
      if (validChannelIds.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No valid channels found for this organization",
        });
      }

      let imported = 0;
      const errors: string[] = [];

      for (let i = 1; i < lines.length; i++) {
        try {
          const row = parseCSVRow(lines[i] as string);
          const content = row[contentIdx]?.trim();
          if (!content) {
            errors.push(`Row ${i + 1}: empty content, skipped`);
            continue;
          }

          let rowScheduledAt: string | undefined;
          if (scheduledAtIdx !== -1 && row[scheduledAtIdx]?.trim()) {
            rowScheduledAt = row[scheduledAtIdx]!.trim();
          } else if (input.scheduledAt) {
            rowScheduledAt = input.scheduledAt;
          }

          const status = rowScheduledAt ? "SCHEDULED" : ("DRAFT" as const);

          await prisma.post.create({
            data: {
              organizationId,
              createdById: (ctx.session.user as any).id,
              content,
              scheduledAt: rowScheduledAt ? new Date(rowScheduledAt) : null,
              status,
              targets: {
                create: validChannelIds.map((channelId) => ({
                  channelId,
                  status,
                })),
              },
            },
          });

          imported++;
        } catch (err: any) {
          errors.push(`Row ${i + 1}: ${err.message || "unknown error"}`);
        }
      }

      return { imported, errors };
    }),

  /**
   * Export posts as CSV data.
   * Returns a CSV string with columns: content, status, scheduledAt, publishedAt, platforms.
   */
  csvExport: protectedProcedure
    .input(
      z.object({
        status: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.organizationId as string;
      if (!organizationId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Organization ID required" });
      }

      const where: any = {
        organizationId,
      };

      if (input.status) {
        where.status = input.status;
      }

      if (input.startDate || input.endDate) {
        where.createdAt = {};
        if (input.startDate) {
          where.createdAt.gte = new Date(input.startDate);
        }
        if (input.endDate) {
          where.createdAt.lte = new Date(input.endDate);
        }
      }

      const posts = await prisma.post.findMany({
        where,
        include: {
          targets: { include: { channel: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      // Build CSV string
      const csvLines: string[] = [
        "content,status,scheduledAt,publishedAt,platforms",
      ];

      for (const post of posts) {
        const platforms = post.targets
          .map((t: any) => t.channel.platform)
          .join(";");
        const escapedContent = escapeCSVField(post.content);
        const scheduledAt = post.scheduledAt
          ? post.scheduledAt.toISOString()
          : "";
        const publishedAt = post.publishedAt
          ? post.publishedAt.toISOString()
          : "";

        csvLines.push(
          `${escapedContent},${post.status},${scheduledAt},${publishedAt},${platforms}`
        );
      }

      return { csv: csvLines.join("\n"), count: posts.length };
    }),
});

/**
 * Parse a single CSV row, handling quoted fields with commas.
 */
function parseCSVRow(row: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const char = row[i] as string;
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < row.length && row[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        fields.push(current);
        current = "";
      } else {
        current += char;
      }
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Escape a field for CSV output. Wraps in quotes if it contains commas, quotes, or newlines.
 */
function escapeCSVField(field: string): string {
  if (field.includes(",") || field.includes('"') || field.includes("\n")) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}
