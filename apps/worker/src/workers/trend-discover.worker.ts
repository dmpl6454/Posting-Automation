import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import {
  QUEUE_NAMES,
  trendScoreQueue,
  type TrendDiscoverJobData,
  createRedisConnection,
} from "@postautomation/queue";
import {
  fetchTrendingNews,
  fetchFromNewsApi,
  fetchFromReddit,
  fetchFromTwitterTrends,
  extractTopics,
  generateTitleHash,
  isSourceOpen,
  recordSourceFailure,
  recordSourceSuccess,
} from "@postautomation/ai";
import type { DiscoveredItem } from "@postautomation/ai";

const DEFAULT_REGION = "IN";
const EXPIRES_HOURS = 48;

export function createTrendDiscoverWorker() {
  const worker = new Worker<TrendDiscoverJobData>(
    QUEUE_NAMES.TREND_DISCOVER,
    async (job: Job<TrendDiscoverJobData>) => {
      const { organizationId, pipelineRunId } = job.data;
      console.log(
        `[TrendDiscover] Processing job ${job.id} for org ${organizationId}, pipeline ${pipelineRunId}`,
      );

      // 1. Fetch all unique topics from active agents in the org
      const agents = await prisma.agent.findMany({
        where: { organizationId, isActive: true },
        select: { topics: true, niche: true },
      });

      const topicSet = new Set<string>();
      for (const agent of agents) {
        if (agent.topics.length > 0) {
          for (const t of agent.topics) topicSet.add(t.toLowerCase());
        } else if (agent.niche) {
          topicSet.add(agent.niche.toLowerCase());
        }
      }

      const topics = topicSet.size > 0 ? Array.from(topicSet) : ["general"];
      const region = DEFAULT_REGION;

      console.log(
        `[TrendDiscover] Fetching trends for ${topics.length} topics: ${topics.join(", ")}`,
      );

      // 2. Fetch from all sources with circuit breaker protection
      const allItems: DiscoveredItem[] = [];

      for (const topic of topics) {
        // Google News
        if (await isSourceOpen("GOOGLE_NEWS")) {
          try {
            const headlines = await fetchTrendingNews(topic, 20);
            for (const h of headlines) {
              allItems.push({
                sourceType: "GOOGLE_NEWS",
                sourceId: generateTitleHash(`google_news:${h.link}`),
                title: h.title,
                summary: h.summary || undefined,
                sourceUrl: h.link,
                sourceName: h.source,
                topics: [topic],
                region,
                publishedAt: h.published ?? new Date(),
              });
            }
            await recordSourceSuccess("GOOGLE_NEWS");
          } catch (error) {
            console.warn(`[TrendDiscover] Google News failed for "${topic}":`, error);
            await recordSourceFailure("GOOGLE_NEWS");
          }
        } else {
          console.log(`[TrendDiscover] Skipping GOOGLE_NEWS (circuit open)`);
        }

        // NewsAPI
        if (await isSourceOpen("NEWSAPI")) {
          try {
            const items = await fetchFromNewsApi(topic, region, 20);
            allItems.push(...items);
            await recordSourceSuccess("NEWSAPI");
          } catch (error) {
            console.warn(`[TrendDiscover] NewsAPI failed for "${topic}":`, error);
            await recordSourceFailure("NEWSAPI");
          }
        } else {
          console.log(`[TrendDiscover] Skipping NEWSAPI (circuit open)`);
        }

        // Reddit
        if (await isSourceOpen("REDDIT")) {
          try {
            const items = await fetchFromReddit(topic, region, "hot", 20);
            allItems.push(...items);
            await recordSourceSuccess("REDDIT");
          } catch (error) {
            console.warn(`[TrendDiscover] Reddit failed for "${topic}":`, error);
            await recordSourceFailure("REDDIT");
          }
        } else {
          console.log(`[TrendDiscover] Skipping REDDIT (circuit open)`);
        }

        // Twitter
        if (await isSourceOpen("TWITTER")) {
          try {
            const items = await fetchFromTwitterTrends(region, 20);
            allItems.push(...items);
            await recordSourceSuccess("TWITTER");
          } catch (error) {
            console.warn(`[TrendDiscover] Twitter failed for "${topic}":`, error);
            await recordSourceFailure("TWITTER");
          }
        } else {
          console.log(`[TrendDiscover] Skipping TWITTER (circuit open)`);
        }
      }

      console.log(
        `[TrendDiscover] Fetched ${allItems.length} raw items from all sources`,
      );

      // 3. Process each discovered item
      const expiresAt = new Date(Date.now() + EXPIRES_HOURS * 60 * 60 * 1000);
      let itemsDiscovered = 0;
      const newItemIds: string[] = [];

      for (const item of allItems) {
        const titleHash = generateTitleHash(item.title);
        const itemTopics =
          item.topics.length > 0 ? item.topics : extractTopics(item.title, item.summary);

        // Cross-source dedup: check if same titleHash exists for this org
        const existing = await prisma.trendingItem.findFirst({
          where: { titleHash, organizationId },
        });

        if (existing) {
          // Merge: update topics if richer, update content if richer
          const mergedTopics = Array.from(
            new Set([...existing.topics, ...itemTopics]),
          );
          const shouldUpdate =
            mergedTopics.length > existing.topics.length ||
            (item.summary && !existing.summary) ||
            (item.fullText && !existing.fullText);

          if (shouldUpdate) {
            await prisma.trendingItem.update({
              where: { id: existing.id },
              data: {
                topics: mergedTopics,
                summary: item.summary || existing.summary,
                fullText: item.fullText || existing.fullText,
                imageUrl: item.imageUrl || existing.imageUrl,
              },
            });
          }
          continue;
        }

        // New item: create TrendingItem (handle P2002 for same-source dedup)
        try {
          const created = await prisma.trendingItem.create({
            data: {
              organizationId,
              sourceType: item.sourceType,
              sourceId: item.sourceId,
              titleHash,
              title: item.title,
              summary: item.summary,
              fullText: item.fullText,
              imageUrl: item.imageUrl,
              sourceUrl: item.sourceUrl,
              sourceName: item.sourceName,
              topics: itemTopics,
              region: item.region || region,
              publishedAt: item.publishedAt,
              viralSignal: item.viralSignal ?? 0,
              expiresAt,
            },
          });

          newItemIds.push(created.id);
          itemsDiscovered++;
        } catch (error: any) {
          // P2002: Unique constraint violation (same sourceId + organizationId)
          if (error?.code === "P2002") {
            console.log(
              `[TrendDiscover] Skipping duplicate source item: ${item.sourceId}`,
            );
            continue;
          }
          throw error;
        }
      }

      // 4. Queue all new items for scoring
      for (const trendingItemId of newItemIds) {
        await trendScoreQueue.add(
          `score-${trendingItemId}`,
          {
            trendingItemId,
            organizationId,
            pipelineRunId,
          },
          {
            removeOnComplete: true,
            removeOnFail: 100,
          },
        );
      }

      // 5. Update PipelineRun with discovery count
      await prisma.pipelineRun.update({
        where: { id: pipelineRunId },
        data: { itemsDiscovered },
      });

      console.log(
        `[TrendDiscover] Done. ${itemsDiscovered} new items discovered, ${newItemIds.length} queued for scoring`,
      );

      return { itemsDiscovered, queued: newItemIds.length };
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
    },
  );

  worker.on("failed", (job, err) => {
    console.error(`[TrendDiscover] Job ${job?.id} failed:`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[TrendDiscover] Job ${job.id} completed`);
  });

  return worker;
}
