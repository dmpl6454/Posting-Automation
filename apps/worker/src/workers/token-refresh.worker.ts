import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import { getSocialProvider, isMetaPlatform, resolveMetaCredentials } from "@postautomation/social";
import { QUEUE_NAMES, type TokenRefreshJobData, createRedisConnection } from "@postautomation/queue";
import { refreshChannelToken, prismaChannelTokenRefreshDeps } from "../lib/channel-token-refresh";

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

      // A Meta token can only be refreshed by the app that minted it, so
      // resolve from the CHANNEL's app rather than from ambient env. NULL
      // metaAppId ⇒ the legacy pair, byte-identical to the old read. Every
      // non-Meta platform keeps the exact `${PREFIX}_CLIENT_ID` lookup.
      const metaCreds = isMetaPlatform(platformEnvPrefix)
        ? resolveMetaCredentials(platformEnvPrefix, channel.metaAppId)
        : null;

      if (isMetaPlatform(platformEnvPrefix) && !metaCreds) {
        // Refusing is correct: refreshing with another app's secret cannot
        // succeed, and silently trying would bury a config error in a
        // token-expiry-shaped failure.
        console.error(
          `[TokenRefresh] Channel ${channelId} is on Meta app ${channel.metaAppId ?? "(legacy)"}, ` +
            `which is not configured on this server — skipping refresh`
        );
        return;
      }

      const config = {
        clientId: metaCreds?.clientId ?? process.env[`${platformEnvPrefix}_CLIENT_ID`] ?? "",
        clientSecret:
          metaCreds?.clientSecret ?? process.env[`${platformEnvPrefix}_CLIENT_SECRET`] ?? "",
        callbackUrl: `${process.env.APP_URL}/api/oauth/callback/${platform.toLowerCase()}`,
        scopes: [],
      };

      // The same race-safe refresh the publish worker uses (2026-10-28): re-read
      // the row, reuse a token another refresher already produced, refresh with
      // the FRESH refresh token, and write only if nothing changed underneath —
      // never onto a channel disconnected meanwhile. TikTok rotates refresh
      // tokens, and this cron used to write unconditionally.
      const outcome = await refreshChannelToken(
        channel.accessToken,
        prismaChannelTokenRefreshDeps(prisma, channelId, (rt) => provider.refreshAccessToken(rt, config))
      );

      console.log(`[TokenRefresh] Token for ${channelId}: ${outcome.kind}`);
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
