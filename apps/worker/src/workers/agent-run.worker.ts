import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { QUEUE_NAMES, postPublishQueue, type AgentRunJobData, createRedisConnection } from "@postautomation/queue";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";
import { resolveOrgAuthor } from "../lib/system-user";
import { resolveAgentRunReview } from "./agent-run-review";

const SCHEDULE_HOURS = [9, 12, 15, 18]; // 9am, 12pm, 3pm, 6pm

// ---------------------------------------------------------------------------
// S3 helpers (same pattern as content-generate.worker.ts)
// ---------------------------------------------------------------------------
function getS3Client(): S3Client {
  return new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || "",
    },
  });
}
const BUCKET = process.env.S3_BUCKET || "postautomation-media";
function getPublicUrl(key: string): string {
  if (process.env.S3_PUBLIC_URL) return `${process.env.S3_PUBLIC_URL}/${key}`;
  return `${process.env.S3_ENDPOINT || "https://s3.amazonaws.com"}/${BUCKET}/${key}`;
}

export function createAgentRunWorker() {
  const worker = new Worker<AgentRunJobData>(
    QUEUE_NAMES.AGENT_RUN,
    async (job: Job<AgentRunJobData>) => {
      const { agentId } = job.data;
      console.log(`[AgentRun] Processing job ${job.id} for agent ${agentId}`);

      // 1. Fetch the Agent with its config (+ accountGroup for the review gate)
      const agent = await prisma.agent.findUniqueOrThrow({
        where: { id: agentId },
        include: { accountGroup: true },
      });

      // Bug #2 (2026-06-24): route agent-run posts through the SAME review gate
      // as the pipeline path. By default posts land in the Autopilot Review
      // Queue as DRAFTs (status REVIEWING) and only publish after approval;
      // they auto-approve + publish immediately ONLY when the agent's Account
      // Group opts into skipReviewGate. Previously this worker created every
      // post as SCHEDULED and published it with no review step at all.
      const review = resolveAgentRunReview(agent);

      // 2. Fetch connected channels
      const channels = await prisma.channel.findMany({
        where: { id: { in: agent.channelIds }, isActive: true },
      });

      if (channels.length === 0) {
        throw new Error(`No active channels found for agent ${agentId}`);
      }

      // 3. Create an AgentRun record
      const agentRun = await prisma.agentRun.create({
        data: {
          agentId: agent.id,
          status: "RUNNING",
        },
      });

      try {
        const { generateContent, fetchTrendingNews, generateStaticNewsCreativeImage, generateRelevantBackground, extractDominantColor } = await import("@postautomation/ai");

        let postsCreated = 0;
        let firstPostContent = "";
        let currentTopicIndex = agent.topicIndex;
        const usedHeadlines = new Set<string>(); // Prevent duplicate headlines

        // Group channels by platform — only post once per platform per post cycle
        const channelsByPlatform = new Map<string, typeof channels>();
        for (const ch of channels) {
          const existing = channelsByPlatform.get(ch.platform) || [];
          existing.push(ch);
          channelsByPlatform.set(ch.platform, existing);
        }
        // Pick ONE channel per platform (first active one)
        const uniqueChannels = Array.from(channelsByPlatform.values()).map((chs) => chs[0]!);
        console.log(`[AgentRun] ${channels.length} total channels → ${uniqueChannels.length} unique platforms: ${Array.from(channelsByPlatform.keys()).join(", ")}`);

        // Pre-fetch a batch of trending headlines to distribute across posts
        const allHeadlines: { title: string; summary?: string; link?: string }[] = [];
        const topics: string[] = [];
        for (let i = 0; i < agent.postsPerDay; i++) {
          const topic = agent.topics.length > 0
            ? agent.topics[(agent.topicIndex + i) % agent.topics.length]!
            : agent.niche;
          topics.push(topic);
        }
        // Fetch unique headlines per topic
        for (const topic of [...new Set(topics)]) {
          try {
            const fetched = await fetchTrendingNews(topic, Math.min(agent.postsPerDay, 10));
            for (const h of fetched) {
              if (h.title && !usedHeadlines.has(h.title)) {
                usedHeadlines.add(h.title);
                allHeadlines.push(h);
              }
            }
          } catch (e) {
            console.warn(`[AgentRun] Could not fetch trending news for "${topic}":`, e);
          }
        }
        console.log(`[AgentRun] Fetched ${allHeadlines.length} unique headlines for ${agent.postsPerDay} posts`);

        // Resolve a real org member to attribute generated posts/media to
        const authorId = await resolveOrgAuthor(agent.organizationId);

        for (let i = 0; i < agent.postsPerDay; i++) {
          const topic = topics[i]!;
          currentTopicIndex = agent.topicIndex + i + 1;

          // Pick a unique headline (round-robin through fetched headlines)
          const headline = allHeadlines[i % Math.max(allHeadlines.length, 1)];
          let newsContext = "";
          if (headline) {
            newsContext = `\n\nLatest trending news:\nHeadline: ${headline.title}${headline.summary ? `\nSummary: ${headline.summary}` : ""}${headline.link ? `\nSource: ${headline.link}` : ""}`;
          }

          // Build prompt with real news context
          const platform = uniqueChannels[0]!.platform;
          let userPrompt: string;

          if (agent.customPrompt) {
            userPrompt = newsContext
              ? `${agent.customPrompt}\n\nUse this trending news as the basis:\n${newsContext}`
              : agent.customPrompt;
          } else if (newsContext) {
            userPrompt = `You are a social media expert for the ${agent.niche} niche. Write a viral ${agent.tone} post based on this trending news:${newsContext}\n\nMake it engaging, include relevant hashtags, and optimise for ${platform}. Write UNIQUE content — do not repeat content from previous posts.`;
          } else {
            userPrompt = `You are a social media expert for the ${agent.niche} niche. Write a viral ${agent.tone} post about "${topic}". Include relevant hashtags and optimise for ${platform}.`;
          }

          // Resilient chain [agent's provider → openai → anthropic]: an agent
          // configured with a billing-held provider (e.g. gemini) no longer
          // FAILs the whole AgentRun — it degrades to a configured provider.
          const { withTextProviderFallback } = await import("@postautomation/ai");
          const content = await withTextProviderFallback(
            agent.aiProvider,
            (p) =>
              generateContent({
                provider: p as any,
                platform,
                userPrompt,
                tone: agent.tone,
              }),
            (failed, next, e) =>
              console.warn(`[AgentRun] Content via ${failed} failed (${e instanceof Error ? e.message.slice(0, 80) : e}), trying ${next}`),
          );

          if (i === 0) {
            firstPostContent = content;
          }

          // Calculate scheduled time (stagger throughout the day)
          const now = new Date();
          const scheduleHour = SCHEDULE_HOURS[i % SCHEDULE_HOURS.length]!;
          const scheduledAt = new Date(now);
          scheduledAt.setHours(scheduleHour, 0, 0, 0);
          if (scheduledAt <= now) {
            scheduledAt.setDate(scheduledAt.getDate() + 1);
          }

          // Create a Post record. When review is required the post is a DRAFT
          // with no scheduledAt until a human approves it in the Review Queue;
          // when the account group skips review it goes straight to SCHEDULED.
          const post = await prisma.post.create({
            data: {
              organizationId: agent.organizationId,
              createdById: authorId,
              content,
              status: review.postStatus,
              aiGenerated: true,
              aiProvider: agent.aiProvider,
              aiPrompt: userPrompt,
              ...(review.publishNow ? { scheduledAt } : {}),
            },
          });

          // Generate news creative image
          const newsHeadline = headline?.title || topic;
          const primaryChannel = uniqueChannels[0]!;
          const meta = (primaryChannel.metadata as Record<string, any>) ?? {};
          const logoUrl = meta.logo_path || primaryChannel.avatar || null;
          const templateType = meta.template_type || "breaking_news";

          // Extract brand color from logo (only once)
          let brandColor: string | null = null;
          if (logoUrl && i === 0) {
            try { brandColor = await extractDominantColor(logoUrl); } catch { /* use default */ }
          }

          let mediaId: string | null = null;
          try {
            const bgImageUrl = await generateRelevantBackground(newsHeadline);

            const result = await generateStaticNewsCreativeImage({
              headline: newsHeadline,
              channelName: primaryChannel.name,
              handle: primaryChannel.username || primaryChannel.name,
              logoUrl,
              template: templateType as any,
              backgroundImageUrl: bgImageUrl || undefined,
              bgSeed: Date.now() + i,
              date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
              ...(brandColor && { brandColor }),
            });

            const s3 = getS3Client();
            const key = `${agent.organizationId}/news-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.jpg`;
            const imgBuffer = Buffer.from(result.imageBase64, "base64");

            await s3.send(new PutObjectCommand({
              Bucket: BUCKET,
              Key: key,
              Body: imgBuffer,
              ContentType: result.mimeType || "image/jpeg",
            }));

            const imageUrl = getPublicUrl(key);

            const media = await prisma.media.create({
              data: {
                organizationId: agent.organizationId,
                uploadedById: authorId,
                url: imageUrl,
                fileName: `news-creative-${i + 1}.jpg`,
                fileType: result.mimeType || "image/jpeg",
                fileSize: imgBuffer.length,
              },
            });

            await prisma.postMedia.create({
              data: { postId: post.id, mediaId: media.id, order: 0 },
            });

            mediaId = media.id;
            console.log(`[AgentRun] Generated news creative for post ${post.id}: ${imageUrl}`);
          } catch (imgErr) {
            console.warn(`[AgentRun] Failed to generate news creative for post ${post.id}:`, imgErr);
          }

          // Create PostTarget — ONE per unique platform (not all channels)
          const mediaRequiredPlatforms = ["INSTAGRAM", "FACEBOOK"];
          let targetsCreated = 0;
          for (let chIdx = 0; chIdx < uniqueChannels.length; chIdx++) {
            const channel = uniqueChannels[chIdx]!;
            // Autopilot only generates still images, never video. YouTube requires
            // a video file, so an image-only YouTube target would always fail at
            // publish time (the PNG gets POSTed to YouTube's video endpoint and
            // rejected). Skip it until autopilot can produce video.
            if (channel.platform === "YOUTUBE") {
              console.warn(`[AgentRun] Skipping YOUTUBE — autopilot produces images, not video`);
              continue;
            }
            if (!mediaId && mediaRequiredPlatforms.includes(channel.platform)) {
              console.warn(`[AgentRun] Skipping ${channel.platform} — no image`);
              continue;
            }

            const postTarget = await prisma.postTarget.create({
              data: {
                postId: post.id,
                channelId: channel.id,
                status: review.targetStatus,
              },
            });
            targetsCreated++;

            // Only enqueue publishing when the account group skips review.
            // Otherwise the target stays DRAFT and is published later by the
            // approve flow (approvePost → autopilot-schedule → publish cron).
            if (review.publishNow) {
              const baseDelay = scheduledAt.getTime() - Date.now();
              const staggerMs = (i * uniqueChannels.length + chIdx) * 10_000;
              await postPublishQueue.add(
                `agent-publish-${post.id}-${channel.id}`,
                {
                  postId: post.id,
                  postTargetId: postTarget.id,
                  channelId: channel.id,
                  platform: channel.platform,
                  organizationId: agent.organizationId,
                },
                {
                  delay: Math.max(baseDelay, 0) + staggerMs,
                  attempts: 3,
                  backoff: { type: "exponential", delay: 60_000 },
                  removeOnComplete: true,
                  removeOnFail: 100,
                }
              );
            }
          }

          // If every channel was skipped there is nothing to publish or review —
          // drop the empty post so it doesn't linger as an orphan DRAFT.
          if (targetsCreated === 0) {
            await prisma.post.delete({ where: { id: post.id } }).catch(() => {});
            console.warn(`[AgentRun] Post ${post.id} had no publishable targets; removed.`);
            continue;
          }

          // Bug #2: record an AutopilotPost so this post is visible + actionable
          // in the Review Queue (and counted by the "Pending Review" stat). The
          // pipeline path keys AutopilotPost off a TrendingItem; the agent-run
          // path has no pipeline TrendingItem, so persist the headline we used
          // as a lightweight one to satisfy the relation. Best-effort: a failure
          // here must NOT lose the post (skip-review posts are already queued).
          try {
            const itemTitle = (headline?.title || topic).slice(0, 280);
            const sourceId = `agent-${post.id}`;
            const trendingItem = await prisma.trendingItem.create({
              data: {
                organizationId: agent.organizationId,
                sourceType: "RSS",
                sourceId,
                titleHash: crypto.createHash("sha256").update(itemTitle).digest("hex"),
                title: itemTitle,
                summary: headline?.summary ?? null,
                sourceUrl: headline?.link || "https://news.google.com",
                sourceName: "Agent",
                topics: [topic],
                publishedAt: new Date(),
                status: "POSTED",
                sensitivity: "LOW",
                // Agent-run items aren't part of a pipeline run; expire in 7 days.
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
              },
            });

            await prisma.autopilotPost.create({
              data: {
                organizationId: agent.organizationId,
                trendingItemId: trendingItem.id,
                agentId: agent.id,
                postId: post.id,
                status: review.autopilotStatus,
                sensitivity: "LOW",
                trendScore: 0,
              },
            });
          } catch (apErr) {
            console.warn(`[AgentRun] Could not create AutopilotPost for review for post ${post.id}:`, apErr);
          }

          postsCreated++;
        }

        // 5. Update AgentRun: COMPLETED
        await prisma.agentRun.update({
          where: { id: agentRun.id },
          data: {
            status: "COMPLETED",
            postsCreated,
            contentPreview: firstPostContent.substring(0, 200),
            completedAt: new Date(),
          },
        });

        // 6. Update Agent tracking
        await prisma.agent.update({
          where: { id: agent.id },
          data: {
            lastRunAt: new Date(),
            totalPosts: { increment: postsCreated },
            topicIndex: currentTopicIndex,
          },
        });

        console.log(`[AgentRun] Agent ${agentId} created ${postsCreated} posts`);
        return { postsCreated };
      } catch (error) {
        // 7. On error: Update AgentRun status
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        await prisma.agentRun.update({
          where: { id: agentRun.id },
          data: {
            status: "FAILED",
            error: errorMessage,
            completedAt: new Date(),
          },
        });
        throw error;
      }
    },
    {
      connection: createRedisConnection(),
      concurrency: 2,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[AgentRun] Job ${job?.id} failed:`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[AgentRun] Job ${job.id} completed`);
  });

  return worker;
}
