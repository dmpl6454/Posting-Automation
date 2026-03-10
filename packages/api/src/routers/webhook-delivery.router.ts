import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, orgProcedure } from "../trpc";
import { webhookDeliveryQueue } from "@postautomation/queue";

export const webhookDeliveryRouter = createRouter({
  list: orgProcedure
    .input(
      z.object({
        webhookId: z.string(),
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(20),
        success: z.boolean().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      // Verify webhook belongs to the organization
      const webhook = await ctx.prisma.webhook.findFirst({
        where: {
          id: input.webhookId,
          organizationId: ctx.organizationId,
        },
      });

      if (!webhook) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Webhook not found" });
      }

      const where: any = { webhookId: input.webhookId };
      if (input.success !== undefined) {
        where.success = input.success;
      }

      const [deliveries, total] = await Promise.all([
        ctx.prisma.webhookDelivery.findMany({
          where,
          orderBy: { deliveredAt: "desc" },
          skip: (input.page - 1) * input.limit,
          take: input.limit,
          select: {
            id: true,
            event: true,
            statusCode: true,
            success: true,
            attempts: true,
            error: true,
            deliveredAt: true,
          },
        }),
        ctx.prisma.webhookDelivery.count({ where }),
      ]);

      return {
        deliveries,
        total,
        page: input.page,
        limit: input.limit,
        totalPages: Math.ceil(total / input.limit),
      };
    }),

  get: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const delivery = await ctx.prisma.webhookDelivery.findUnique({
        where: { id: input.id },
        include: {
          webhook: {
            select: {
              id: true,
              organizationId: true,
              url: true,
              events: true,
              isActive: true,
            },
          },
        },
      });

      if (!delivery) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Delivery not found" });
      }

      // Verify ownership through org scope
      if (delivery.webhook.organizationId !== ctx.organizationId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      return delivery;
    }),

  retry: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const delivery = await ctx.prisma.webhookDelivery.findUnique({
        where: { id: input.id },
        include: {
          webhook: {
            select: {
              id: true,
              organizationId: true,
              url: true,
              secret: true,
            },
          },
        },
      });

      if (!delivery) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Delivery not found" });
      }

      if (delivery.webhook.organizationId !== ctx.organizationId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      // Increment attempts on the existing delivery record
      await ctx.prisma.webhookDelivery.update({
        where: { id: input.id },
        data: { attempts: { increment: 1 } },
      });

      // Re-enqueue the delivery job
      await webhookDeliveryQueue.add(
        `retry-${delivery.id}`,
        {
          webhookDeliveryId: delivery.id,
          webhookId: delivery.webhook.id,
          url: delivery.webhook.url,
          secret: delivery.webhook.secret,
          event: delivery.event,
          payload: delivery.payload as Record<string, unknown>,
        },
        {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        }
      );

      return { success: true };
    }),
});
