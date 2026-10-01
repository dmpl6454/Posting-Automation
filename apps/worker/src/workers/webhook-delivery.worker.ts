import { Worker, UnrecoverableError, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { QUEUE_NAMES, type WebhookDeliveryJobData, createRedisConnection } from "@postautomation/queue";
import { userHostFetch, isUserHostError } from "@postautomation/social";
import crypto from "crypto";

function generateSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Deliver one webhook. The URL is one an org admin typed in, and the first 1KB
 * of the reply is shown on the delivery page — so the request goes through
 * userHostFetch: only to checked public addresses, never following a redirect,
 * with a deadline. Plain fetch() made this a reflective SSRF: the create-time
 * check was a hostname regex, and fetch() re-resolved the name and followed
 * redirects to internal hosts (2026-10-01).
 */
export async function processWebhookDelivery(job: Job<WebhookDeliveryJobData>) {
  const { webhookDeliveryId, webhookId, url, secret, event, payload } = job.data;
  console.log(`[WebhookDelivery] Processing job ${job.id} for delivery ${webhookDeliveryId}`);

  const body = JSON.stringify(payload);
  const signature = generateSignature(body, secret);

  let statusCode: number | undefined;
  let responseBody: string | undefined;

  try {
    const response = await userHostFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Event": event,
        "X-Webhook-Signature": signature,
        "User-Agent": "PostAutomation-Webhooks/1.0",
      },
      body,
      timeoutMs: 30_000,
      maxResponseBytes: 64 * 1024,
      // A 2xx means the receiver accepted the event; a big reply must not turn
      // that into a failure (and a redelivery).
      truncateAtCap: true,
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
    // A refused or redirected request carries fixed text; keep the 3xx status.
    if (isUserHostError(err) && err.kind === "redirect") statusCode = err.status;
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

    // Not retryable: the address is not public, or the receiver redirected —
    // it may already have handled the POST, so redelivering would repeat it.
    if (isUserHostError(err) && (err.kind === "redirect" || err.kind === "blocked" || err.kind === "bad_url")) {
      throw new UnrecoverableError(errorMessage);
    }
    throw err; // Re-throw so BullMQ handles the retry
  }
}

export function createWebhookDeliveryWorker() {
  const worker = new Worker<WebhookDeliveryJobData>(
    QUEUE_NAMES.WEBHOOK_DELIVERY,
    processWebhookDelivery,
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
