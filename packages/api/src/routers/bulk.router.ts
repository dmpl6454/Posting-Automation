// TODO(security): these procedures are protectedProcedure and take the org id from
// input WITHOUT an OrganizationMember check (pre-existing gap, noted during the
// 2026-07-17 RBAC sweep). Fix separately: resolve org via orgProcedure ctx instead.
import { z } from "zod";
import { createRouter, protectedProcedure } from "../trpc";
import { prisma } from "@postautomation/db";
import { TRPCError } from "@trpc/server";
import Papa from "papaparse";

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
   * Fix #28: uses papaparse for robust multi-line quoted field handling.
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

      // Fix #28: replace line-by-line split parser with papaparse
      const parsed = Papa.parse<Record<string, string>>(input.csvData, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => h.trim().toLowerCase(),
      });

      if (parsed.errors.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `CSV parse error: ${parsed.errors[0]!.message}`,
        });
      }

      const rows = parsed.data;

      if (rows.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "CSV must have a header row and at least one data row",
        });
      }

      // Validate that the "content" column exists
      const firstRow = rows[0];
      if (!firstRow || !("content" in firstRow)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: 'CSV must have a "content" column',
        });
      }

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

      for (let i = 0; i < rows.length; i++) {
        try {
          const row = rows[i]!;
          const content = row["content"]?.trim();
          if (!content) {
            errors.push(`Row ${i + 2}: empty content, skipped`);
            continue;
          }

          const rowScheduledAt =
            row["scheduledat"]?.trim() || row["scheduledAt"]?.trim() || input.scheduledAt;

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
          errors.push(`Row ${i + 2}: ${err.message || "unknown error"}`);
        }
      }

      return { imported, errors };
    }),

  /**
   * Export posts as CSV data.
   * Returns a CSV string with columns: content, status, scheduledAt, publishedAt, platforms.
   * Fix #25: "ALL" status filter treated as no filter.
   * Fix #26: CRLF line endings + UTF-8 BOM for Excel compatibility.
   * Fix #27: all fields are properly escaped.
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

      // Fix #25: ignore "ALL" — treat it as no filter
      if (input.status && input.status !== "ALL") {
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
      // Fix #27: escape ALL fields, not just content
      const e = escapeCSVField;
      const csvLines: string[] = [
        "content,status,scheduledAt,publishedAt,platforms",
      ];

      for (const post of posts) {
        const platforms = e(
          post.targets.map((t: any) => t.channel.platform).join(";")
        );
        const scheduledAt = e(
          post.scheduledAt ? post.scheduledAt.toISOString() : ""
        );
        const publishedAt = e(
          post.publishedAt ? post.publishedAt.toISOString() : ""
        );

        csvLines.push(
          `${e(post.content)},${e(post.status)},${scheduledAt},${publishedAt},${platforms}`
        );
      }

      // Fix #26: CRLF line endings + UTF-8 BOM so Excel opens correctly on Windows
      return { csv: "﻿" + csvLines.join("\r\n"), count: posts.length };
    }),
});

/**
 * Escape a field for CSV output.
 * Fix #27: wraps in quotes if it contains commas, quotes, newlines, or carriage returns.
 */
function escapeCSVField(field: string): string {
  if (
    field.includes(",") ||
    field.includes('"') ||
    field.includes("\n") ||
    field.includes("\r")
  ) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}
