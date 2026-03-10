import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";

export const approvalRouter = createRouter({
  submit: orgProcedure
    .input(
      z.object({
        postId: z.string(),
        reviewerIds: z.array(z.string()).min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Verify the post exists and belongs to the org
      const post = await ctx.prisma.post.findFirst({
        where: {
          id: input.postId,
          organizationId: ctx.organizationId,
        },
      });
      if (!post) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Post not found" });
      }

      // Check if there's already a pending approval request for this post
      const existing = await ctx.prisma.approvalRequest.findFirst({
        where: {
          postId: input.postId,
          status: "PENDING",
        },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "An approval request is already pending for this post",
        });
      }

      const requestedById = (ctx.session.user as any).id as string;
      const totalSteps = input.reviewerIds.length;

      const approvalRequest = await ctx.prisma.approvalRequest.create({
        data: {
          organizationId: ctx.organizationId,
          postId: input.postId,
          requestedById,
          totalSteps,
          currentStep: 1,
          status: "PENDING",
          steps: {
            create: input.reviewerIds.map((reviewerId, index) => ({
              stepNumber: index + 1,
              reviewerId,
              status: "PENDING",
            })),
          },
        },
        include: {
          steps: true,
        },
      });

      // Notify the first reviewer
      const firstReviewerId = input.reviewerIds[0] as string;
      await ctx.prisma.notification.create({
        data: {
          organizationId: ctx.organizationId,
          userId: firstReviewerId,
          type: "approval.requested",
          title: "Approval Requested",
          body: `You have been asked to review a post for approval.`,
          link: `/dashboard/approvals`,
        },
      });

      return approvalRequest;
    }),

  review: orgProcedure
    .input(
      z.object({
        approvalRequestId: z.string(),
        decision: z.enum(["APPROVED", "REJECTED"]),
        comment: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = (ctx.session.user as any).id as string;

      const approvalRequest = await ctx.prisma.approvalRequest.findFirst({
        where: {
          id: input.approvalRequestId,
          organizationId: ctx.organizationId,
          status: "PENDING",
        },
        include: { steps: { orderBy: { stepNumber: "asc" } } },
      });

      if (!approvalRequest) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Approval request not found or not pending",
        });
      }

      // Find the current step that should be reviewed by this user
      const currentStep = approvalRequest.steps.find(
        (step) =>
          step.stepNumber === approvalRequest.currentStep &&
          step.reviewerId === userId &&
          (step.status as string) === "PENDING"
      );

      if (!currentStep) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not the reviewer for the current step",
        });
      }

      // Update the step
      await ctx.prisma.approvalStep.update({
        where: { id: currentStep.id },
        data: {
          status: input.decision,
          comment: input.comment,
          decidedAt: new Date(),
        },
      });

      const decision = input.decision as string;

      if (decision === "REJECTED") {
        // Mark the entire approval request as rejected
        await ctx.prisma.approvalRequest.update({
          where: { id: approvalRequest.id },
          data: { status: "REJECTED" },
        });

        // Notify the submitter about rejection
        await ctx.prisma.notification.create({
          data: {
            organizationId: ctx.organizationId,
            userId: approvalRequest.requestedById,
            type: "approval.rejected",
            title: "Approval Rejected",
            body: `Your post has been rejected.${input.comment ? ` Comment: ${input.comment}` : ""}`,
            link: `/dashboard/posts`,
          },
        });
      } else if (decision === "APPROVED") {
        const isLastStep =
          approvalRequest.currentStep >= approvalRequest.totalSteps;

        if (isLastStep) {
          // All steps approved - update request and post
          await ctx.prisma.approvalRequest.update({
            where: { id: approvalRequest.id },
            data: { status: "APPROVED" },
          });

          // Update the post status to SCHEDULED (ready to publish)
          await ctx.prisma.post.update({
            where: { id: approvalRequest.postId },
            data: { status: "SCHEDULED" },
          });

          // Notify the submitter about approval
          await ctx.prisma.notification.create({
            data: {
              organizationId: ctx.organizationId,
              userId: approvalRequest.requestedById,
              type: "approval.approved",
              title: "Post Approved",
              body: "Your post has been approved by all reviewers.",
              link: `/dashboard/posts`,
            },
          });
        } else {
          // Move to next step
          const nextStepNumber = approvalRequest.currentStep + 1;
          await ctx.prisma.approvalRequest.update({
            where: { id: approvalRequest.id },
            data: { currentStep: nextStepNumber },
          });

          // Find the next reviewer and notify them
          const nextStep = approvalRequest.steps.find(
            (step) => step.stepNumber === nextStepNumber
          );
          if (nextStep) {
            await ctx.prisma.notification.create({
              data: {
                organizationId: ctx.organizationId,
                userId: nextStep.reviewerId,
                type: "approval.requested",
                title: "Approval Requested",
                body: `You have been asked to review a post for approval (step ${nextStepNumber} of ${approvalRequest.totalSteps}).`,
                link: `/dashboard/approvals`,
              },
            });
          }
        }
      }

      return { success: true };
    }),

  list: orgProcedure
    .input(
      z.object({
        status: z
          .enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"])
          .optional(),
        limit: z.number().min(1).max(100).default(20),
        cursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = (ctx.session.user as any).id as string;

      // Find approval requests where the current user is a reviewer on a pending step
      const approvalRequests = await ctx.prisma.approvalRequest.findMany({
        where: {
          organizationId: ctx.organizationId,
          ...(input.status ? { status: input.status } : {}),
          steps: {
            some: {
              reviewerId: userId,
            },
          },
        },
        include: {
          steps: {
            orderBy: { stepNumber: "asc" },
          },
        },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
      });

      let nextCursor: string | undefined;
      if (approvalRequests.length > input.limit) {
        const lastItem = approvalRequests.pop();
        nextCursor = lastItem?.id;
      }

      // Enrich with post data and requester info
      const enriched = await Promise.all(
        approvalRequests.map(async (req) => {
          const [post, requester] = await Promise.all([
            ctx.prisma.post.findUnique({
              where: { id: req.postId },
              select: {
                id: true,
                content: true,
                status: true,
                createdAt: true,
              },
            }),
            ctx.prisma.user.findUnique({
              where: { id: req.requestedById },
              select: { id: true, name: true, email: true, image: true },
            }),
          ]);
          return { ...req, post, requester };
        })
      );

      return { approvalRequests: enriched, nextCursor };
    }),

  getForPost: orgProcedure
    .input(z.object({ postId: z.string() }))
    .query(async ({ ctx, input }) => {
      const approvalRequest = await ctx.prisma.approvalRequest.findFirst({
        where: {
          postId: input.postId,
          organizationId: ctx.organizationId,
        },
        include: {
          steps: {
            orderBy: { stepNumber: "asc" },
            include: {
              // We cannot include user directly on ApprovalStep because there's no relation.
              // We'll resolve reviewer info separately below.
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      if (!approvalRequest) return null;

      // Resolve reviewer names
      const reviewerIds = approvalRequest.steps.map((s) => s.reviewerId);
      const reviewers = await ctx.prisma.user.findMany({
        where: { id: { in: reviewerIds } },
        select: { id: true, name: true, email: true, image: true },
      });
      const reviewerMap = new Map(reviewers.map((r) => [r.id, r]));

      const stepsWithReviewers = approvalRequest.steps.map((step) => ({
        ...step,
        reviewer: reviewerMap.get(step.reviewerId) ?? null,
      }));

      return { ...approvalRequest, steps: stepsWithReviewers };
    }),

  cancel: orgProcedure
    .input(z.object({ approvalRequestId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = (ctx.session.user as any).id as string;

      const approvalRequest = await ctx.prisma.approvalRequest.findFirst({
        where: {
          id: input.approvalRequestId,
          organizationId: ctx.organizationId,
          status: "PENDING",
        },
      });

      if (!approvalRequest) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Approval request not found or not pending",
        });
      }

      // Only the original submitter or an admin can cancel
      if (approvalRequest.requestedById !== userId) {
        const membership = await ctx.prisma.organizationMember.findUnique({
          where: {
            userId_organizationId: {
              userId,
              organizationId: ctx.organizationId,
            },
          },
        });
        const role = membership?.role as string;
        if (role !== "OWNER" && role !== "ADMIN") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only the submitter or an admin can cancel",
          });
        }
      }

      await ctx.prisma.approvalRequest.update({
        where: { id: input.approvalRequestId },
        data: { status: "CANCELLED" },
      });

      // Cancel all pending steps
      await ctx.prisma.approvalStep.updateMany({
        where: {
          approvalRequestId: input.approvalRequestId,
          status: "PENDING",
        },
        data: { status: "CANCELLED" },
      });

      return { success: true };
    }),
});
