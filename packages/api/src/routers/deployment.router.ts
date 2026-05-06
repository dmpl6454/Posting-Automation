import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure, superAdminProcedure } from "../trpc";

export const deploymentRouter = createRouter({
  /** Get current version info */
  current: orgProcedure.query(async ({ ctx }) => {
    const latest = await ctx.prisma.deployment.findFirst({
      where: { status: "active" },
      orderBy: { createdAt: "desc" },
    });
    return {
      version: process.env.NEXT_PUBLIC_APP_VERSION || latest?.version || "1.0.0-dev",
      commitHash: process.env.NEXT_PUBLIC_COMMIT_HASH || latest?.commitHash || "unknown",
      commitDate: process.env.NEXT_PUBLIC_COMMIT_DATE || latest?.createdAt?.toISOString() || "",
      branch: process.env.NEXT_PUBLIC_BRANCH || latest?.branch || "main",
      commitMsg: process.env.NEXT_PUBLIC_COMMIT_MSG || latest?.commitMsg || "",
      buildTime: process.env.NEXT_PUBLIC_BUILD_TIME || "",
      deploymentId: latest?.id,
    };
  }),

  /** List all deployments */
  list: orgProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(50).default(20),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const items = await ctx.prisma.deployment.findMany({
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

  /** Register a new deployment (called by CI/CD or deploy script) */
  register: orgProcedure
    .input(
      z.object({
        version: z.string(),
        commitHash: z.string(),
        commitMsg: z.string(),
        branch: z.string().default("main"),
        changelog: z.string().optional(),
        environment: z.string().default("production"),
        metadata: z.record(z.any()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Mark all previous active deployments as superseded
      await ctx.prisma.deployment.updateMany({
        where: { status: "active", environment: input.environment },
        data: { status: "superseded" },
      });

      const deployment = await ctx.prisma.deployment.create({
        data: {
          version: input.version,
          commitHash: input.commitHash,
          commitMsg: input.commitMsg,
          branch: input.branch,
          changelog: input.changelog,
          environment: input.environment,
          deployedBy: (ctx.session.user as any)?.id || "ci",
          status: "active",
          metadata: input.metadata || undefined,
        },
      });

      return deployment;
    }),

  /**
   * Rollback to a specific deployment.
   *
   * SECURITY: previously this was `orgProcedure`, which meant any member
   * of any organization could roll back the production deployment for the
   * entire platform (deployments are global, not org-scoped). This is a
   * super-admin operation only.
   */
  rollback: superAdminProcedure
    .input(z.object({ deploymentId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const target = await ctx.prisma.deployment.findUnique({
        where: { id: input.deploymentId },
      });
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Deployment not found" });
      }

      // Mark current active as rolled_back
      const current = await ctx.prisma.deployment.findFirst({
        where: { status: "active" },
        orderBy: { createdAt: "desc" },
      });

      if (current) {
        await ctx.prisma.deployment.update({
          where: { id: current.id },
          data: {
            status: "rolled_back",
            rolledBackAt: new Date(),
            rolledBackTo: target.id,
          },
        });
      }

      // Create a new deployment entry for the rollback
      const rollbackDeployment = await ctx.prisma.deployment.create({
        data: {
          version: `${target.version}-rollback`,
          commitHash: target.commitHash,
          commitMsg: `Rollback to v${target.version} (${target.commitHash})`,
          branch: target.branch,
          environment: target.environment,
          deployedBy: (ctx.session.user as any)?.id || "manual",
          status: "active",
          metadata: { rolledBackFrom: current?.id, rolledBackTo: target.id },
        },
      });

      return {
        rollbackDeployment,
        targetVersion: target.version,
        targetCommit: target.commitHash,
        message: `Rollback initiated to v${target.version} (${target.commitHash}). Run the deploy script on the server to complete.`,
      };
    }),
});
