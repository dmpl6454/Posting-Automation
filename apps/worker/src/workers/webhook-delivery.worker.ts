import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { QUEUE_NAMES, type WebhookDeliveryJobData, createRedisConnection } from "@postautomation/queue";
import crypto from "crypto";

function generateSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function createWebhookDeliveryWorker() {
  const worker = new Worker<WebhookDeliveryJobData>(
    QUEUE_NAMES.WEBHOOK_DELIVERY,
    async (job: Job<WebhookDeliveryJobData>) => {
      const { webhookDeliveryId, webhookId, url, secret, event, payload } = job.data;
      console.log(`[WebhookDelivery] Processing job ${job.id} for delivery ${webhookDeliveryId}`);

      const body = JSON.stringify(payload);
      const signature = generateSignature(body, secret);

      let statusCode: number | undefined;
      let responseBody: string | undefined;

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Event": event,
            "X-Webhook-Signature": signature,
            "User-Agent": "PostAutomation-Webhooks/1.0",
          },
          body,
          signal: AbortSignal.timeout(30_000), // 30s timeout
        });

        statusCode = response.status;
        const rawResponse = await response.text();
        responseBody = rawResponse.slice(0, 1000);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${responseBody}`);
        }

        // Success — update the delivery record
        await prisma.webhookDelivery.update({
          where: { id: webhookDeliveryId },
          data: {
            success: true,
            statusCode,
            response: responseBody,
            deliveredAt: new Date(),
          },
        });

        console.log(`[WebhookDelivery] Successfully delivered ${webhookDeliveryId} to ${url} (${statusCode})`);
        return { statusCode, success: true };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[WebhookDelivery] Delivery ${webhookDeliveryId} failed: ${errorMessage}`);

        // Update delivery record with failure
        await prisma.webhookDelivery.update({
          where: { id: webhookDeliveryId },
          data: {
            success: false,
            statusCode: statusCode ?? null,
            response: responseBody ?? null,
            error: errorMessage.slice(0, 1000),
            attempts: { increment: 1 },
          },
        });

        throw err; // Re-throw so BullMQ handles the retry
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 10,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    }
  );

  worker.on("failed", (job, err) => {
    const attempt = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts?.attempts ?? 3;
    if (attempt >= maxAttempts) {
      console.error(`[WebhookDelivery] Job ${job?.id} permanently failed after ${attempt} attempts: ${err.message}`);
    } else {
      console.warn(`[WebhookDelivery] Job ${job?.id} attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
    }
  });

  worker.on("completed", (job) => {
    console.log(`[WebhookDelivery] Job ${job.id} completed`);
  });

  return worker;
}
