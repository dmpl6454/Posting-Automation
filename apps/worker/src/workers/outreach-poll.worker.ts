import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import {
  QUEUE_NAMES,
  type OutreachPollJobData,
  outreachSendQueue,
  createRedisConnection,
} from "@postautomation/queue";

const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_OUTREACH_MODEL ?? "llama3.3:70b";

interface GeneratedMessages {
  email?: { subject: string; body: string };
  linkedin?: { body: string };
  twitter?: { body: string };
  instagram?: { body: string };
}

async function generateOutreachMessages(
  brandName: string,
  celebrityNames: string[],
  signalType: string,
  signalUrl: string | null
): Promise<GeneratedMessages> {
  const celebList = celebrityNames.join(", ");
  const campaignRef = signalUrl ? `\nCampaign reference: ${signalUrl}` : "";
  const signalLabel =
    signalType === "AD_LIBRARY" ? "a live paid ad campaign featuring"
    : signalType === "PR_NEWS" ? "a press release announcing an endorsement deal with"
    : signalType === "SOCIAL_MEDIA" ? "social media activity featuring"
    : "a job posting indicating they are scaling a celebrity campaign";

  const prompt = `You are a marketing agency business development executive. Generate outreach messages to pitch your full-service marketing agency to ${brandName}, who is running ${signalLabel} ${celebList}.${campaignRef}

Your agency offers: content creation, social media management, paid ads, influencer coordination, and campaign analytics.

Return ONLY valid JSON with this exact structure:
{
  "email": {
    "subject": "short email subject line under 60 chars",
    "body": "professional email pitch 150 words max, reference their specific campaign"
  },
  "linkedin": {
    "body": "professional LinkedIn connection note 80 words max"
  },
  "twitter": {
    "body": "punchy Twitter DM 40 words max"
  },
  "instagram": {
    "body": "casual Instagram DM 60 words max"
  }
}`;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        format: "json",
        options: { temperature: 0.7, num_predict: 600 },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
    const data = await res.json() as any;
    const parsed = JSON.parse(data.response);
    return parsed as GeneratedMessages;
  } catch (err) {
    console.error(`[OutreachPoll] Message generation failed, using template fallback: ${err}`);
    // Fallback templates
    return {
      email: {
        subject: `Marketing agency partnership — ${brandName} × ${celebList}`,
        body: `Hi ${brandName} team,\n\nI noticed your exciting campaign featuring ${celebList} and wanted to reach out. Our full-service marketing agency specializes in amplifying celebrity-led brand campaigns through strategic content, social media management, and paid distribution.\n\nWe'd love to discuss how we can help maximize your campaign's reach and ROI.\n\nBest regards`,
      },
      linkedin: {
        body: `Hi! I saw ${brandName}'s campaign featuring ${celebList} — great move. Our agency specializes in scaling celebrity-led campaigns. Would love to connect and explore how we can add value.`,
      },
      twitter: {
        body: `Hey @${brandName} — love the ${celebList} collab! Our agency helps brands like yours maximize campaign reach. Open to a quick chat?`,
      },
      instagram: {
        body: `Hey ${brandName}! 👋 Loved the ${celebList} campaign. We're a marketing agency that helps brands amplify celebrity collabs. DM us to explore working together!`,
      },
    };
  }
}

export function createOutreachPollWorker() {
  const worker = new Worker<OutreachPollJobData>(
    QUEUE_NAMES.OUTREACH_POLL,
    async (job: Job<OutreachPollJobData>) => {
      const { organizationId } = job.data;
      console.log(`[OutreachPoll] Checking approved leads for org ${organizationId}`);

      // Find approved leads that haven't had messages generated yet
      const approvedLeads = await prisma.outreachLead.findMany({
        where: {
          status: "APPROVED",
          messages: { none: {} },
          signal: { organizationId },
        },
        include: { signal: true },
        take: 20,
      });

      console.log(`[OutreachPoll] Found ${approvedLeads.length} approved leads to process`);

      for (const lead of approvedLeads) {
        const signal = lead.signal;
        console.log(`[OutreachPoll] Generating messages for lead ${lead.id} — ${signal.brandName}`);

        const msgs = await generateOutreachMessages(
          signal.brandName,
          signal.celebrityNames,
          signal.signalType,
          signal.signalUrl
        );

        // Determine which channels to send based on available contact info
        const channelsToCreate: Array<{ channel: string; subject?: string; body: string }> = [];

        if (signal.brandEmail && msgs.email) {
          channelsToCreate.push({ channel: "EMAIL", subject: msgs.email.subject, body: msgs.email.body });
        }
        if (signal.brandLinkedin && msgs.linkedin) {
          channelsToCreate.push({ channel: "LINKEDIN", body: msgs.linkedin.body });
        }
        if (signal.brandTwitter && msgs.twitter) {
          channelsToCreate.push({ channel: "TWITTER", body: msgs.twitter.body });
        }
        if (signal.brandInstagram && msgs.instagram) {
          channelsToCreate.push({ channel: "INSTAGRAM", body: msgs.instagram.body });
        }

        if (channelsToCreate.length === 0) {
          console.warn(`[OutreachPoll] No contact info for brand ${signal.brandName}, skipping`);
          await prisma.outreachLead.update({ where: { id: lead.id }, data: { status: "FAILED" } });
          continue;
        }

        // Create message records
        const createdMessages = await Promise.all(
          channelsToCreate.map((ch) =>
            prisma.outreachMessage.create({
              data: {
                leadId: lead.id,
                channel: ch.channel as any,
                subject: ch.subject ?? null,
                body: ch.body,
                status: "DRAFT",
              },
            })
          )
        );

        // Queue outreach-send jobs for each message
        for (const msg of createdMessages) {
          await outreachSendQueue.add(
            `send-${msg.channel.toLowerCase()}-${msg.id}`,
            { messageId: msg.id, leadId: lead.id },
            { delay: 2000 } // small stagger
          );
        }

        console.log(`[OutreachPoll] Queued ${createdMessages.length} outreach jobs for lead ${lead.id}`);
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[OutreachPoll] Job ${job?.id} failed: ${err.message}`);
  });

  worker.on("completed", (job) => {
    console.log(`[OutreachPoll] Job ${job.id} completed`);
  });

  return worker;
}
