import { z } from "zod";
import { createRouter, protectedProcedure, superAdminProcedure } from "../trpc";
import crypto from "crypto";

/**
 * Every `source` string the codebase writes to the ErrorLog table.
 * SINGLE source of truth — the router enums + UI tabs derive from this so a
 * worker can't write a source value the Monitoring UI silently can't filter on.
 * `auto-healer` added 2026-06-22 (the auto-healer worker already wrote it, but
 * the filter enum omitted it → its summary rows were invisible in the dashboard).
 */
export const ERROR_LOG_SOURCES = ["frontend", "api", "worker", "publish", "auto-healer"] as const;

/** Schema for a written source (logError). */
export const errorLogSourceSchema = z.enum(ERROR_LOG_SOURCES);

/** Schema for the list filter (adds the "all" pseudo-source). */
export const errorLogSourceFilterSchema = z.enum([...ERROR_LOG_SOURCES, "all"]);

/** Generate a fingerprint for deduplication */
function errorFingerprint(message: string, stack?: string): string {
  const input = `${message}::${(stack || "").split("\n").slice(0, 3).join("")}`;
  return crypto.createHash("md5").update(input).digest("hex");
}

export const monitorRouter = createRouter({
  /**
   * Log an error.
   *
   * SECURITY: previously this was `publicProcedure` and accepted
   * client-supplied `organizationId` / `userId` — that allowed any
   * unauthenticated client to forge error rows attributed to any tenant
   * (DB junk-fill + audit-log poisoning). It is now `protectedProcedure`,
   * the org/user are taken from the session only, and the input fields
   * for `organizationId` / `userId` are removed.
   */
  logError: protectedProcedure
    .input(
      z.object({
        source: errorLogSourceSchema,
        severity: z.enum(["error", "warning", "critical"]).default("error"),
        message: z.string().max(5000),
        stack: z.string().max(10000).optional(),
        endpoint: z.string().max(500).optional(),
        userAgent: z.string().max(500).optional(),
        metadata: z.record(z.any()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const fp = errorFingerprint(input.message, input.stack);
      const userId = (ctx.session?.user as any)?.id as string | undefined;
      const organizationId = (ctx as any).organizationId as string | undefined;

      // Deduplicate: if same fingerprint exists in last 24h, increment count
      const existing = await ctx.prisma.errorLog.findFirst({
        where: {
          fingerprint: fp,
          resolved: false,
          lastSeenAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });

      if (existing) {
        await ctx.prisma.errorLog.update({
          where: { id: existing.id },
          data: {
            occurrences: { increment: 1 },
            lastSeenAt: new Date(),
            metadata: input.metadata || (existing.metadata as any) || undefined,
          },
        });
        return { id: existing.id, deduplicated: true };
      }

      const log = await ctx.prisma.errorLog.create({
        data: {
          source: input.source,
          severity: input.severity,
          message: input.message,
          stack: input.stack,
          endpoint: input.endpoint,
          userAgent: input.userAgent,
          metadata: input.metadata ?? undefined,
          organizationId,
          userId,
          fingerprint: fp,
        },
      });

      return { id: log.id, deduplicated: false };
    }),

  /**
   * List errors. Restricted to super-admins because the errorLog table
   * spans all tenants and may contain sensitive stack traces / PII from
   * other orgs. Previously `protectedProcedure` allowed any logged-in
   * user to read the entire error stream.
   */
  list: superAdminProcedure
    .input(
      z.object({
        source: errorLogSourceFilterSchema.default("all"),
        severity: z.enum(["error", "warning", "critical", "all"]).default("all"),
        resolved: z.boolean().optional(),
        limit: z.number().min(1).max(200).default(50),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const where: any = {};
      if (input.source !== "all") where.source = input.source;
      if (input.severity !== "all") where.severity = input.severity;
      if (input.resolved !== undefined) where.resolved = input.resolved;

      const errors = await ctx.prisma.errorLog.findMany({
        where,
        orderBy: { lastSeenAt: "desc" },
        take: input.limit + 1,
        cursor: input.cursor ? { id: input.cursor } : undefined,
      });

      let nextCursor: string | undefined;
      if (errors.length > input.limit) {
        const next = errors.pop()!;
        nextCursor = next.id;
      }

      return { errors, nextCursor };
    }),

  /** Get error stats summary (super-admin only — cross-tenant) */
  stats: superAdminProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [total, unresolved, last24h, lastWeek, bySource, bySeverity] = await Promise.all([
      ctx.prisma.errorLog.count(),
      ctx.prisma.errorLog.count({ where: { resolved: false } }),
      ctx.prisma.errorLog.count({ where: { lastSeenAt: { gte: dayAgo } } }),
      ctx.prisma.errorLog.count({ where: { lastSeenAt: { gte: weekAgo } } }),
      ctx.prisma.errorLog.groupBy({
        by: ["source"],
        _count: true,
        where: { resolved: false },
      }),
      ctx.prisma.errorLog.groupBy({
        by: ["severity"],
        _count: true,
        where: { resolved: false },
      }),
    ]);

    return {
      total,
      unresolved,
      last24h,
      lastWeek,
      bySource: Object.fromEntries(bySource.map((s) => [s.source, s._count])),
      bySeverity: Object.fromEntries(bySeverity.map((s) => [s.severity, s._count])),
    };
  }),

  /** Resolve an error (super-admin only — cross-tenant audit data) */
  resolve: superAdminProcedure
    .input(
      z.object({
        id: z.string(),
        note: z.string().max(2000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.errorLog.update({
        where: { id: input.id },
        data: {
          resolved: true,
          resolvedAt: new Date(),
          resolvedBy: (ctx.session?.user as any)?.id,
          resolvedNote: input.note,
        },
      });
    }),

  /** Bulk resolve errors (super-admin only) */
  bulkResolve: superAdminProcedure
    .input(z.object({ ids: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.errorLog.updateMany({
        where: { id: { in: input.ids } },
        data: {
          resolved: true,
          resolvedAt: new Date(),
          resolvedBy: (ctx.session?.user as any)?.id,
        },
      });
    }),

  /**
   * Hard-delete ALL resolved errors on demand (super-admin only).
   * The manual companion to the daily auto-purge cron — lets an operator
   * clear the resolved backlog from the Monitoring page in one click.
   */
  clearResolved: superAdminProcedure.mutation(async ({ ctx }) => {
    return ctx.prisma.errorLog.deleteMany({ where: { resolved: true } });
  }),

  /** Export errors as Claude-friendly report (super-admin only) */
  exportForClaude: superAdminProcedure
    .input(
      z.object({
        unresolvedOnly: z.boolean().default(true),
        limit: z.number().default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const errors = await ctx.prisma.errorLog.findMany({
        where: input.unresolvedOnly ? { resolved: false } : {},
        orderBy: [{ severity: "asc" }, { occurrences: "desc" }],
        take: input.limit,
      });

      // Fix #67: redact tokens, keys, emails, IPs, JWTs before including in report
      const REDACTORS: Array<[RegExp, string]> = [
        [/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]"],
        [/(sk|pk)_(test|live)_[A-Za-z0-9]+/g, "[REDACTED_STRIPE_KEY]"],
        [/AIza[0-9A-Za-z_\-]{35}/g, "[REDACTED_GOOGLE_KEY]"],
        [/eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, "[REDACTED_JWT]"],
        [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]"],
        [/\b\d{12,19}\b/g, "[REDACTED_NUMBER]"],
        [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]"],
        [/(AKIA|ASIA)[A-Z0-9]{16}/g, "[REDACTED_AWS_KEY]"],
        [/ghp_[A-Za-z0-9]{36}/g, "[REDACTED_GH_TOKEN]"],
        [/xox[baprs]-[A-Za-z0-9\-]+/g, "[REDACTED_SLACK_TOKEN]"],
      ];

      const redact = (s: string) =>
        REDACTORS.reduce((acc, [re, rep]) => acc.replace(re, rep), s);

      // Format as a structured report for Claude
      const lines = [
        `# Error Report — ${new Date().toISOString().split("T")[0]}`,
        `Total unresolved: ${errors.length}`,
        "",
      ];

      for (const err of errors) {
        lines.push(`## [${err.severity.toUpperCase()}] ${err.source} — ${err.occurrences}x`);
        lines.push(`**Message:** ${redact(err.message)}`);
        if (err.endpoint) lines.push(`**Endpoint:** ${redact(err.endpoint)}`);
        if (err.stack) lines.push(`**Stack:** \`\`\`\n${redact(err.stack.split("\n").slice(0, 5).join("\n"))}\n\`\`\``);
        if (err.metadata) lines.push(`**Context:** ${redact(JSON.stringify(err.metadata))}`);
        lines.push(`**First seen:** ${err.firstSeenAt.toISOString()} | **Last seen:** ${err.lastSeenAt.toISOString()}`);
        lines.push(`**ID:** ${err.id}`);
        lines.push("");
      }

      return { report: lines.join("\n"), count: errors.length };
    }),
});
