import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { QUEUE_NAMES, postPublishQueue, type AgentRunJobData, createRedisConnection } from "@postautomation/queue";

const SCHEDULE_HOURS = [9, 12, 15, 18]; // 9am, 12pm, 3pm, 6pm

export function createAgentRunWorker() {
  const worker = new Worker<AgentRunJobData>(
    QUEUE_NAMES.AGENT_RUN,
    async (job: Job<AgentRunJobData>) => {
      const { agentId } = job.data;
      console.log(`[AgentRun] Processing job ${job.id} for agent ${agentId}`);

      // 1. Fetch the Agent with its config
      const agent = await prisma.agent.findUniqueOrThrow({
        where: { id: agentId },
      });

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
        const { generateContent, fetchTrendingNews } = await import("@postautomation/ai");

        let postsCreated = 0;
        let firstPostContent = "";
        let currentTopicIndex = agent.topicIndex;

        for (let i = 0; i < agent.postsPerDay; i++) {
          // 4a. Pick a topic
          let topic: string;
          if (agent.topics.length > 0) {
            topic = agent.topics[currentTopicIndex % agent.topics.length]!;
            currentTopicIndex++;
          } else {
            topic = agent.niche;
          }

          // 4b. Fetch real trending news for this topic
          let newsContext = "";
          try {
            const headlines = await fetchTrendingNews(topic, 5);
            if (headlines.length > 0) {
              const top = headlines[0]!;
              newsContext = `\n\nLatest trending news:\nHeadline: ${top.title}${top.summary ? `\nSummary: ${top.summary}` : ""}${top.link ? `\nSource: ${top.link}` : ""}`;
              console.log(`[AgentRun] Fetched trending news for "${topic}": ${top.title}`);
            }
          } catch (e) {
            console.warn(`[AgentRun] Could not fetch trending news for "${topic}":`, e);
          }

          // 4c. Build prompt with real news context
          const platform = channels[0]!.platform;
          let userPrompt: string;

          if (agent.customPrompt) {
            userPrompt = newsContext
              ? `${agent.customPrompt}\n\nUse this trending news as the basis:\n${newsContext}`
              : agent.customPrompt;
          } else if (newsContext) {
            userPrompt = `You are a social media expert for the ${agent.niche} niche. Write a viral ${agent.tone} post based on this trending news:${newsContext}\n\nMake it engaging, include relevant hashtags, and optimise for ${platform}.`;
          } else {
            userPrompt = `You are a social media expert for the ${agent.niche} niche. Write a viral ${agent.tone} post about "${topic}". Include relevant hashtags and optimise for ${platform}.`;
          }

          const content = await generateContent({
            provider: agent.aiProvider as any,
            platform,
            userPrompt,
            tone: agent.tone,
          });

          if (i === 0) {
            firstPostContent = content;
          }

          // 4e. Calculate scheduled time (stagger throughout the day)
          const now = new Date();
          const scheduleHour = SCHEDULE_HOURS[i % SCHEDULE_HOURS.length]!;
          const scheduledAt = new Date(now);
          scheduledAt.setHours(scheduleHour, 0, 0, 0);
          // If the scheduled time is in the past, push to tomorrow
          if (scheduledAt <= now) {
            scheduledAt.setDate(scheduledAt.getDate() + 1);
          }

          // 4e. Create a Post record
          const post = await prisma.post.create({
            data: {
              organizationId: agent.organizationId,
              createdById: "agent-system",
              content,
              status: "SCHEDULED",
              aiGenerated: true,
              aiProvider: agent.aiProvider,
              aiPrompt: userPrompt,
              scheduledAt,
            },
          });

          // 4f. Create PostTarget records for each channel
          for (const channel of channels) {
            const postTarget = await prisma.postTarget.create({
              data: {
                postId: post.id,
                channelId: channel.id,
                status: "SCHEDULED",
              },
            });

            // 4g. Queue post-publish jobs with delay
            const delay = scheduledAt.getTime() - Date.now();
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
                delay: Math.max(delay, 0),
                removeOnComplete: true,
                removeOnFail: 100,
              }
            );
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
