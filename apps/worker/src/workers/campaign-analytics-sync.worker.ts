import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import {
  QUEUE_NAMES,
  type CampaignAnalyticsSyncJobData,
  createRedisConnection,
} from "@postautomation/queue";

export function createCampaignAnalyticsSyncWorker() {
  const worker = new Worker<CampaignAnalyticsSyncJobData>(
    QUEUE_NAMES.CAMPAIGN_ANALYTICS_SYNC,
    async (job: Job<CampaignAnalyticsSyncJobData>) => {
      const { campaignId, organizationId } = job.data;
      console.log(`[CampaignAnalyticsSync] Processing campaign ${campaignId}`);

      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        include: {
          campaignPosts: {
            include: {
              post: {
                include: {
                  targets: {
                    where: { status: "PUBLISHED" },
                    select: { id: true },
                  },
                },
              },
            },
          },
        },
      });

      if (!campaign) {
        return { skipped: true, reason: "not_found" };
      }

      let totalImpressions = 0;
      let totalClicks = 0;
      let totalEngagements = 0;
      let totalReach = 0;

      // For each campaign post, fetch latest analytics from AnalyticsSnapshot
      for (const cp of campaign.campaignPosts) {
        const targetIds = cp.post.targets.map((t) => t.id);
        if (targetIds.length === 0) continue;

        // Get latest snapshot for each target
        for (const targetId of targetIds) {
          const snapshot = await prisma.analyticsSnapshot.findFirst({
            where: { postTargetId: targetId },
            orderBy: { snapshotAt: "desc" },
          });

          if (snapshot) {
            const impressions = snapshot.impressions;
            const clicks = snapshot.clicks;
            const engagements = snapshot.likes + snapshot.comments + snapshot.shares;
            const reach = snapshot.reach;

            totalImpressions += impressions;
            totalClicks += clicks;
            totalEngagements += engagements;
            totalReach += reach;

            // Update per-post metrics
            await prisma.campaignPost.update({
              where: { id: cp.id },
              data: {
                impressions,
                clicks,
                engagements,
                reach,
              },
            });
          }
        }
      }

      // Update campaign aggregated metrics
      await prisma.campaign.update({
        where: { id: campaignId },
        data: {
          totalImpressions,
          totalClicks,
          totalEngagements,
          totalReach,
          lastSyncAt: new Date(),
        },
      });

      console.log(`[CampaignAnalyticsSync] Done. Campaign ${campaignId}: ${totalImpressions} impressions, ${totalEngagements} engagements`);
      return { totalImpressions, totalClicks, totalEngagements, totalReach };
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[CampaignAnalyticsSync] Job ${job?.id} failed:`, err.message);
  });

  worker.on("completed", (job) => {
    console.log(`[CampaignAnalyticsSync] Job ${job.id} completed`);
  });

  return worker;
}
