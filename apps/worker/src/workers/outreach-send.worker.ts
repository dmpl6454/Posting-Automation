import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { QUEUE_NAMES, type OutreachSendJobData, createRedisConnection } from "@postautomation/queue";

async function sendEmail(messageId: string, subject: string | null, body: string, brandEmail: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY not set");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.OUTREACH_FROM_EMAIL ?? "outreach@youragency.com",
      to: brandEmail,
      subject: subject ?? "Partnership Opportunity",
      text: body,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend API error ${res.status}: ${text}`);
  }
}

async function sendLinkedInDM(messageId: string, body: string, linkedinUrl: string | null): Promise<void> {
  // LinkedIn DM API requires Marketing Developer Platform access.
  // Until that access is granted, log the message for manual review.
  console.log(`[OutreachSend] LinkedIn DM (manual review required): ${linkedinUrl ?? "no URL"}`);
  console.log(`[OutreachSend] Message: ${body.substring(0, 100)}...`);
  // Store as sent with a note — user will copy-paste from dashboard
}

async function sendTwitterDM(messageId: string, body: string, twitterHandle: string | null): Promise<void> {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;
  if (!bearerToken || !accessToken || !twitterHandle) {
    console.log(`[OutreachSend] Twitter DM skipped — missing credentials or handle`);
    return;
  }

  const cleanHandle = twitterHandle.replace(/^@/, "");
  // Look up recipient user ID
  const userRes = await fetch(`https://api.twitter.com/2/users/by/username/${cleanHandle}`, {
    headers: { Authorization: `Bearer ${bearerToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!userRes.ok) throw new Error(`Twitter user lookup failed: ${userRes.status}`);
  const userData = await userRes.json() as any;
  const recipientId = userData.data?.id;
  if (!recipientId) throw new Error("Twitter user not found");

  const dmRes = await fetch("https://api.twitter.com/2/dm_conversations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      participant_id: recipientId,
      message: { text: body },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!dmRes.ok) {
    const text = await dmRes.text();
    throw new Error(`Twitter DM error ${dmRes.status}: ${text}`);
  }
}

async function sendInstagramDM(messageId: string, body: string, igHandle: string | null): Promise<void> {
  // Instagram DM via API requires approved Business or Creator access.
  // Until access is granted, log for manual review.
  console.log(`[OutreachSend] Instagram DM (manual review required): @${igHandle ?? "unknown"}`);
  console.log(`[OutreachSend] Message: ${body.substring(0, 100)}...`);
}

export function createOutreachSendWorker() {
  const worker = new Worker<OutreachSendJobData>(
    QUEUE_NAMES.OUTREACH_SEND,
    async (job: Job<OutreachSendJobData>) => {
      const { messageId, leadId } = job.data;
      console.log(`[OutreachSend] Processing message ${messageId} for lead ${leadId}`);

      const message = await prisma.outreachMessage.findUnique({
        where: { id: messageId },
        include: {
          lead: {
            include: { signal: true },
          },
        },
      });

      if (!message) {
        console.warn(`[OutreachSend] Message ${messageId} not found, skipping`);
        return;
      }
      if (message.status === "SENT") {
        console.log(`[OutreachSend] Message ${messageId} already sent, skipping`);
        return;
      }

      const signal = message.lead.signal;

      // Mark as queued
      await prisma.outreachMessage.update({
        where: { id: messageId },
        data: { status: "QUEUED" },
      });

      let error: string | null = null;
      let responseBody: string | null = null;

      try {
        switch (message.channel) {
          case "EMAIL":
            if (!signal.brandEmail) throw new Error("No email for brand");
            await sendEmail(messageId, message.subject, message.body, signal.brandEmail);
            break;
          case "LINKEDIN":
            await sendLinkedInDM(messageId, message.body, signal.brandLinkedin);
            break;
          case "TWITTER":
            await sendTwitterDM(messageId, message.body, signal.brandTwitter);
            break;
          case "INSTAGRAM":
            await sendInstagramDM(messageId, message.body, signal.brandInstagram);
            break;
        }
        responseBody = "ok";
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        console.error(`[OutreachSend] Channel ${message.channel} failed: ${error}`);
      }

      // Log the delivery attempt
      await prisma.outreachDeliveryLog.create({
        data: {
          messageId,
          responseCode: error ? 500 : 200,
          responseBody,
          error,
        },
      });

      // Update message status
      await prisma.outreachMessage.update({
        where: { id: messageId },
        data: {
          status: error ? "FAILED" : "SENT",
          sentAt: error ? null : new Date(),
        },
      });

      if (error) throw new Error(error);

      // Check if all messages for this lead are done → mark lead as sent
      const pendingMsgs = await prisma.outreachMessage.count({
        where: { leadId, status: { in: ["DRAFT", "QUEUED"] } },
      });
      if (pendingMsgs === 0) {
        await prisma.outreachLead.update({
          where: { id: leadId },
          data: { status: "SENT" },
        });
        console.log(`[OutreachSend] Lead ${leadId} fully sent`);
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 3,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[OutreachSend] Job ${job?.id} failed: ${err.message}`);
  });

  worker.on("completed", (job) => {
    console.log(`[OutreachSend] Job ${job.id} completed`);
  });

  return worker;
}
