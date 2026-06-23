import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { QUEUE_NAMES, type OutreachSendJobData, createRedisConnection } from "@postautomation/queue";

// A send attempt has three honest outcomes (a thrown error is the fourth,
// handled by the caller's try/catch → FAILED):
//   "sent"           — the message was actually delivered via a real API.
//   "pending_manual" — the channel has no programmatic send API (LinkedIn/IG
//                      DM). The copy is ready; the operator must send by hand.
//                      We must NOT mark these SENT — that would falsely claim
//                      delivery (the gap this fix closes).
type SendOutcome = "sent" | "pending_manual";

async function sendEmail(messageId: string, subject: string | null, body: string, brandEmail: string): Promise<SendOutcome> {
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
  return "sent";
}

async function sendLinkedInDM(messageId: string, body: string, linkedinUrl: string | null): Promise<SendOutcome> {
  // LinkedIn DM API requires Marketing Developer Platform access we don't have.
  // We CANNOT send programmatically, so report "pending_manual" — the dashboard
  // shows the generated copy for the operator to send by hand. Do NOT return
  // "sent" / mark SENT here: that falsely claims a DM was delivered.
  console.log(`[OutreachSend] LinkedIn DM pending manual send: ${linkedinUrl ?? "no URL"}`);
  return "pending_manual";
}

async function sendTwitterDM(messageId: string, body: string, twitterHandle: string | null): Promise<SendOutcome> {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;
  if (!bearerToken || !accessToken || !twitterHandle) {
    // Can't send (no DM credentials / no handle) — fall back to manual, don't
    // pretend it was sent.
    console.log(`[OutreachSend] Twitter DM pending manual send — missing credentials or handle`);
    return "pending_manual";
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
  return "sent";
}

async function sendInstagramDM(messageId: string, body: string, igHandle: string | null): Promise<SendOutcome> {
  // Instagram DM via API requires approved Business/Creator access we don't have.
  // Report "pending_manual" (not "sent") — the operator sends from the dashboard.
  console.log(`[OutreachSend] Instagram DM pending manual send: @${igHandle ?? "unknown"}`);
  return "pending_manual";
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
      let outcome: SendOutcome | null = null;

      try {
        switch (message.channel) {
          case "EMAIL":
            if (!signal.brandEmail) throw new Error("No email for brand");
            outcome = await sendEmail(messageId, message.subject, message.body, signal.brandEmail);
            break;
          case "LINKEDIN":
            outcome = await sendLinkedInDM(messageId, message.body, signal.brandLinkedin);
            break;
          case "TWITTER":
            outcome = await sendTwitterDM(messageId, message.body, signal.brandTwitter);
            break;
          case "INSTAGRAM":
            outcome = await sendInstagramDM(messageId, message.body, signal.brandInstagram);
            break;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        console.error(`[OutreachSend] Channel ${message.channel} failed: ${error}`);
      }

      // Map the outcome to an honest message status:
      //   error            → FAILED
      //   "pending_manual" → PENDING_MANUAL (no real send happened; operator sends)
      //   "sent"           → SENT (actually delivered)
      const newStatus = error
        ? "FAILED"
        : outcome === "pending_manual"
        ? "PENDING_MANUAL"
        : "SENT";

      // Log the delivery attempt. A pending-manual outcome is not a 200 "delivered"
      // — record it as 0/"pending_manual" so the delivery log doesn't read as a send.
      await prisma.outreachDeliveryLog.create({
        data: {
          messageId,
          responseCode: error ? 500 : newStatus === "PENDING_MANUAL" ? 0 : 200,
          responseBody: error ? null : newStatus === "PENDING_MANUAL" ? "pending_manual" : "ok",
          error,
        },
      });

      // Update message status
      await prisma.outreachMessage.update({
        where: { id: messageId },
        data: {
          status: newStatus,
          // sentAt is set ONLY on a real send — never for PENDING_MANUAL.
          sentAt: newStatus === "SENT" ? new Date() : null,
        },
      });

      if (error) throw new Error(error);

      // Mark the lead SENT only when every message has reached a TERMINAL-SENT
      // state. DRAFT/QUEUED are still in-flight; PENDING_MANUAL is awaiting a
      // human action — both mean the lead is NOT done, so they keep it out of
      // SENT. (Previously only DRAFT/QUEUED counted, so a LinkedIn-only lead
      // flipped to SENT while nothing was actually delivered.)
      const pendingMsgs = await prisma.outreachMessage.count({
        where: { leadId, status: { in: ["DRAFT", "QUEUED", "PENDING_MANUAL"] } },
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
