import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { getSocialProvider } from "@postautomation/social";
import { QUEUE_NAMES, type TokenRefreshJobData, createRedisConnection } from "@postautomation/queue";

export function createTokenRefreshWorker() {
  const worker = new Worker<TokenRefreshJobData>(
    QUEUE_NAMES.TOKEN_REFRESH,
    async (job: Job<TokenRefreshJobData>) => {
      const { channelId, platform } = job.data;
      console.log(`[TokenRefresh] Refreshing token for channel ${channelId} (${platform})`);

      const channel = await prisma.channel.findUniqueOrThrow({
        where: { id: channelId },
      });

      if (!channel.refreshToken) {
        console.log(`[TokenRefresh] No refresh token for channel ${channelId}, skipping`);
        return;
      }

      const provider = getSocialProvider(platform as any);
      const platformEnvPrefix = platform.toUpperCase();
      const config = {
        clientId: process.env[`${platformEnvPrefix}_CLIENT_ID`] || "",
        clientSecret: process.env[`${platformEnvPrefix}_CLIENT_SECRET`] || "",
        callbackUrl: `${process.env.APP_URL}/api/oauth/callback/${platform.toLowerCase()}`,
        scopes: [],
      };

      const newTokens = await provider.refreshAccessToken(channel.refreshToken, config);

      await prisma.channel.update({
        where: { id: channelId },
        data: {
          accessToken: newTokens.accessToken,
          refreshToken: newTokens.refreshToken ?? channel.refreshToken,
          tokenExpiresAt: newTokens.expiresAt,
        },
      });

      console.log(`[TokenRefresh] Successfully refreshed token for ${channelId}`);
    },
    {
      connection: createRedisConnection(),
      concurrency: 3,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[TokenRefresh] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
