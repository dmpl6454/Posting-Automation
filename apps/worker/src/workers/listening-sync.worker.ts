import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import {
  QUEUE_NAMES,
  sentimentAnalysisQueue,
  type ListeningSyncJobData,
  createRedisConnection,
} from "@postautomation/queue";

export function createListeningSyncWorker() {
  const worker = new Worker<ListeningSyncJobData>(
    QUEUE_NAMES.LISTENING_SYNC,
    async (job: Job<ListeningSyncJobData>) => {
      const { listeningQueryId, organizationId } = job.data;
      console.log(`[ListeningSync] Processing query ${listeningQueryId}`);

      const query = await prisma.listeningQuery.findUnique({
        where: { id: listeningQueryId },
      });

      if (!query || !query.isActive) {
        return { skipped: true, reason: "inactive_or_not_found" };
      }

      let mentionsCreated = 0;

      // Fetch mentions from Google News RSS for each keyword
      for (const keyword of query.keywords) {
        try {
          const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=${query.language}`;
          const response = await fetch(rssUrl);
          const xml = await response.text();

          // Simple XML parsing for RSS items
          const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

          for (const item of items.slice(0, 10)) {
            const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
              || item.match(/<title>(.*?)<\/title>/)?.[1]
              || "";
            const link = item.match(/<link>(.*?)<\/link>/)?.[1] || "";
            const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1];
            const source = item.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || "Google News";

            if (!title) continue;

            // Skip if excluded words are present
            const lower = title.toLowerCase();
            if (query.excludeWords.some((w) => lower.includes(w.toLowerCase()))) continue;

            // Check for duplicates
            const existing = await prisma.mention.findFirst({
              where: {
                listeningQueryId: query.id,
                sourceUrl: link,
              },
            });
            if (existing) continue;

            const mention = await prisma.mention.create({
              data: {
                listeningQueryId: query.id,
                source: "NEWS",
                sourceUrl: link,
                authorName: source,
                content: title,
                mentionedAt: pubDate ? new Date(pubDate) : new Date(),
                reach: 0,
                engagements: 0,
              },
            });

            // Queue sentiment analysis
            await sentimentAnalysisQueue.add(
              `sentiment-${mention.id}`,
              { mentionId: mention.id, content: title },
              { removeOnComplete: true, removeOnFail: 100 }
            );

            mentionsCreated++;
          }
        } catch (err) {
          console.warn(`[ListeningSync] Failed to fetch for keyword "${keyword}":`, err);
        }
      }

      // Update last sync time
      await prisma.listeningQuery.update({
        where: { id: listeningQueryId },
        data: { lastSyncAt: new Date() },
      });

      // Check for volume spikes and create alerts
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

      const [recentCount, previousCount] = await Promise.all([
        prisma.mention.count({
          where: { listeningQueryId, mentionedAt: { gte: oneDayAgo } },
        }),
        prisma.mention.count({
          where: { listeningQueryId, mentionedAt: { gte: twoDaysAgo, lt: oneDayAgo } },
        }),
      ]);

      // Volume surge alert: 2x increase
      if (previousCount > 0 && recentCount >= previousCount * 2) {
        await prisma.sentimentAlert.create({
          data: {
            listeningQueryId,
            type: "volume_surge",
            title: `Mention volume surge for "${query.name}"`,
            description: `Mentions increased from ${previousCount} to ${recentCount} in the last 24 hours (${Math.round((recentCount / previousCount - 1) * 100)}% increase).`,
            severity: recentCount >= previousCount * 5 ? "critical" : "high",
          },
        });
      }

      // Negative sentiment spike alert
      const recentNegative = await prisma.mention.count({
        where: {
          listeningQueryId,
          mentionedAt: { gte: oneDayAgo },
          sentiment: "NEGATIVE",
        },
      });

      if (recentCount > 0 && recentNegative / recentCount > 0.5 && recentNegative >= 3) {
        await prisma.sentimentAlert.create({
          data: {
            listeningQueryId,
            type: "spike_negative",
            title: `Negative sentiment spike for "${query.name}"`,
            description: `${recentNegative} out of ${recentCount} mentions in the last 24 hours are negative (${Math.round((recentNegative / recentCount) * 100)}%).`,
            severity: "high",
          },
        });
      }

      console.log(`[ListeningSync] Done. Created ${mentionsCreated} new mentions for query ${listeningQueryId}`);
      return { mentionsCreated };
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[ListeningSync] Job ${job?.id} failed:`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[ListeningSync] Job ${job.id} completed`);
  });

  return worker;
}
