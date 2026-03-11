import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { QUEUE_NAMES, type RssSyncJobData, createRedisConnection } from "@postautomation/queue";
import { parseRssItems, type RssItem } from "@postautomation/ai/src/utils/rss-parser";

async function generatePostFromEntry(
  entry: { title: string; summary: string },
  promptTemplate: string | null,
): Promise<string> {
  try {
    // Dynamic import — @postautomation/ai is optional for the worker
    const { generateContent } = await import("@postautomation/ai");
    const prompt = promptTemplate
      ? promptTemplate
          .replace("{{title}}", entry.title)
          .replace("{{summary}}", entry.summary || "")
      : `Create an engaging social media post about this article:\nTitle: ${entry.title}\nSummary: ${entry.summary || "No summary available"}`;

    const content = await generateContent({
      provider: "openai",
      platform: "TWITTER",
      userPrompt: prompt,
    });
    return content;
  } catch (error) {
    console.error("[RssSync] AI generation failed, using fallback:", error);
    return `${entry.title}\n\n${entry.summary || ""}`.trim();
  }
}

export function createRssSyncWorker() {
  const worker = new Worker<RssSyncJobData>(
    QUEUE_NAMES.RSS_SYNC,
    async (job: Job<RssSyncJobData>) => {
      const { feedId, organizationId } = job.data;
      console.log(`[RssSync] Processing job ${job.id} for feed ${feedId}`);

      // 1. Get the feed
      const feed = await prisma.rssFeed.findUnique({ where: { id: feedId } });
      if (!feed || !feed.isActive) {
        console.log(`[RssSync] Feed ${feedId} not found or inactive, skipping`);
        return;
      }

      // 2. Fetch the RSS feed XML
      const response = await fetch(feed.url, {
        headers: {
          "User-Agent": "PostAutomation RSS Reader/1.0",
          Accept: "application/rss+xml, application/xml, text/xml, application/atom+xml",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch RSS feed: HTTP ${response.status}`);
      }

      const xml = (await response.text()) as string;

      // 3. Parse items from the XML
      const items = parseRssItems(xml);
      console.log(`[RssSync] Found ${items.length} items in feed ${feed.name}`);

      // 4. Get existing guids to avoid duplicates
      const existingGuids = new Set(
        (
          await prisma.rssFeedEntry.findMany({
            where: { feedId },
            select: { guid: true },
          })
        ).map((e) => e.guid)
      );

      // 5. Create new entries
      let newEntryCount = 0;

      for (const item of items) {
        if (existingGuids.has(item.guid)) continue;

        await prisma.rssFeedEntry.create({
          data: {
            feedId,
            guid: item.guid,
            title: item.title,
            link: item.link,
            summary: item.summary || null,
            published: item.published,
          },
        });
        newEntryCount++;
      }

      console.log(`[RssSync] Created ${newEntryCount} new entries for feed ${feed.name}`);

      // 6. If autoPost is enabled, generate posts for new unprocessed entries
      if (feed.autoPost && feed.targetChannels.length > 0) {
        const unprocessedEntries = await prisma.rssFeedEntry.findMany({
          where: { feedId, processed: false },
          orderBy: { createdAt: "asc" },
          take: 10, // Process at most 10 at a time
        });

        for (const entry of unprocessedEntries) {
          try {
            const content = await generatePostFromEntry(
              { title: entry.title, summary: entry.summary || "" },
              feed.promptTemplate
            );

            await prisma.post.create({
              data: {
                organizationId,
                createdById: "system",
                content,
                status: "DRAFT",
                aiGenerated: true,
                aiProvider: "openai",
                aiPrompt: `RSS auto-post from: ${entry.title}`,
                targets: {
                  create: feed.targetChannels.map((channelId) => ({
                    channelId,
                    status: "DRAFT" as const,
                  })),
                },
              },
            });

            await prisma.rssFeedEntry.update({
              where: { id: entry.id },
              data: { processed: true },
            });

            console.log(`[RssSync] Created auto-post for entry: ${entry.title}`);
          } catch (error) {
            console.error(
              `[RssSync] Failed to create post for entry ${entry.id}:`,
              error
            );
          }
        }
      }

      // 7. Update lastCheckedAt
      await prisma.rssFeed.update({
        where: { id: feedId },
        data: { lastCheckedAt: new Date() },
      });

      console.log(`[RssSync] Completed sync for feed ${feed.name}`);
    },
    {
      connection: createRedisConnection(),
      concurrency: 2,
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[RssSync] Job ${job?.id} failed:`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[RssSync] Job ${job.id} completed`);
  });

  return worker;
}
