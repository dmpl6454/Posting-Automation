import { Worker, type Job } from "bullmq";
import { prisma } from "@postautomation/db";
import type { MentionSource } from "@postautomation/db";
import {
  QUEUE_NAMES,
  type CampaignAnalyticsSyncJobData,
  createRedisConnection,
} from "@postautomation/queue";

interface RawBrandContent {
  platform: MentionSource;
  contentType: string;
  content: string;
  contentUrl: string | null;
  mediaUrl: string | null;
  authorHandle: string | null;
  engagements: number;
  likes: number;
  comments: number;
  shares: number;
  views: number;
  hashtags: string[];
  publishedAt: Date;
  metadata?: Record<string, unknown>;
}

/** Fetch tweets from a Twitter/X handle */
async function fetchTwitterContent(handle: string): Promise<RawBrandContent[]> {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN;
  if (!bearerToken || !handle) return [];
  const items: RawBrandContent[] = [];
  try {
    const cleanHandle = handle.replace(/^@/, "");
    // Get user ID first
    const userRes = await fetch(`https://api.twitter.com/2/users/by/username/${cleanHandle}?user.fields=public_metrics`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!userRes.ok) return [];
    const userData = await userRes.json() as any;
    const userId = userData.data?.id;
    if (!userId) return [];

    // Fetch recent tweets
    const tweetsRes = await fetch(
      `https://api.twitter.com/2/users/${userId}/tweets?max_results=10&tweet.fields=created_at,public_metrics,entities&media.fields=url,preview_image_url&expansions=attachments.media_keys`,
      { headers: { Authorization: `Bearer ${bearerToken}` }, signal: AbortSignal.timeout(10_000) }
    );
    if (!tweetsRes.ok) return [];
    const tweetsData = await tweetsRes.json() as any;
    const mediaMap = new Map<string, string>();
    for (const m of tweetsData.includes?.media || []) {
      mediaMap.set(m.media_key, m.url || m.preview_image_url || "");
    }

    for (const tweet of tweetsData.data || []) {
      const metrics = tweet.public_metrics || {};
      const mediaKeys = tweet.attachments?.media_keys || [];
      const hashtags = (tweet.entities?.hashtags || []).map((h: any) => h.tag);
      items.push({
        platform: "TWITTER",
        contentType: mediaKeys.length > 0 ? "post" : "post",
        content: tweet.text,
        contentUrl: `https://x.com/${cleanHandle}/status/${tweet.id}`,
        mediaUrl: mediaKeys[0] ? mediaMap.get(mediaKeys[0]) || null : null,
        authorHandle: `@${cleanHandle}`,
        engagements: (metrics.like_count || 0) + (metrics.retweet_count || 0) + (metrics.reply_count || 0),
        likes: metrics.like_count || 0,
        comments: metrics.reply_count || 0,
        shares: metrics.retweet_count || 0,
        views: metrics.impression_count || 0,
        hashtags,
        publishedAt: new Date(tweet.created_at),
      });
    }
  } catch (err) {
    console.warn(`[BrandSync:Twitter] Failed for @${handle}:`, err);
  }
  return items;
}

/** Fetch Instagram posts via Graph API hashtag or user ID */
async function fetchInstagramContent(handle: string, orgId: string): Promise<RawBrandContent[]> {
  const items: RawBrandContent[] = [];
  try {
    // Use org's connected Instagram channels for API access
    const channels = await prisma.channel.findMany({
      where: { organizationId: orgId, platform: "INSTAGRAM", isActive: true },
      select: { accessToken: true, platformId: true },
    });
    if (channels.length === 0) return [];
    const { accessToken, platformId } = channels[0]!;

    // Search by hashtag
    const cleanHandle = handle.replace(/^@/, "");
    const searchUrl = `https://graph.facebook.com/v18.0/ig_hashtag_search?q=${encodeURIComponent(cleanHandle)}&user_id=${platformId}&access_token=${accessToken}`;
    const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(10_000) });
    if (!searchRes.ok) return [];
    const searchData = await searchRes.json() as any;
    const hashtagId = searchData.data?.[0]?.id;
    if (!hashtagId) return [];

    const mediaUrl = `https://graph.facebook.com/v18.0/${hashtagId}/recent_media?user_id=${platformId}&fields=id,caption,timestamp,permalink,like_count,comments_count,media_url,media_type&access_token=${accessToken}&limit=10`;
    const mediaRes = await fetch(mediaUrl, { signal: AbortSignal.timeout(10_000) });
    if (!mediaRes.ok) return [];
    const mediaData = await mediaRes.json() as any;

    for (const post of mediaData.data || []) {
      const hashtags = (post.caption || "").match(/#\w+/g)?.map((t: string) => t.slice(1)) || [];
      items.push({
        platform: "INSTAGRAM",
        contentType: post.media_type === "VIDEO" ? "reel" : "post",
        content: (post.caption || "").slice(0, 1000),
        contentUrl: post.permalink || null,
        mediaUrl: post.media_url || null,
        authorHandle: `@${cleanHandle}`,
        engagements: (post.like_count || 0) + (post.comments_count || 0),
        likes: post.like_count || 0,
        comments: post.comments_count || 0,
        shares: 0,
        views: 0,
        hashtags,
        publishedAt: new Date(post.timestamp),
      });
    }
  } catch (err) {
    console.warn(`[BrandSync:Instagram] Failed for ${handle}:`, err);
  }
  return items;
}

/** Fetch Facebook page posts */
async function fetchFacebookContent(pageId: string, orgId: string): Promise<RawBrandContent[]> {
  const items: RawBrandContent[] = [];
  try {
    const channels = await prisma.channel.findMany({
      where: { organizationId: orgId, platform: "FACEBOOK", isActive: true },
      select: { accessToken: true },
    });
    if (channels.length === 0) return [];
    const { accessToken } = channels[0]!;

    const url = `https://graph.facebook.com/v18.0/${pageId}/posts?fields=message,created_time,permalink_url,shares,reactions.summary(true),comments.summary(true),full_picture&limit=10&access_token=${accessToken}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return [];
    const data = await response.json() as any;

    for (const post of data.data || []) {
      if (!post.message) continue;
      const hashtags = (post.message || "").match(/#\w+/g)?.map((t: string) => t.slice(1)) || [];
      items.push({
        platform: "FACEBOOK",
        contentType: "post",
        content: post.message.slice(0, 1000),
        contentUrl: post.permalink_url || null,
        mediaUrl: post.full_picture || null,
        authorHandle: pageId,
        engagements: (post.reactions?.summary?.total_count || 0) + (post.comments?.summary?.total_count || 0) + (post.shares?.count || 0),
        likes: post.reactions?.summary?.total_count || 0,
        comments: post.comments?.summary?.total_count || 0,
        shares: post.shares?.count || 0,
        views: 0,
        hashtags,
        publishedAt: new Date(post.created_time),
      });
    }
  } catch (err) {
    console.warn(`[BrandSync:Facebook] Failed for ${pageId}:`, err);
  }
  return items;
}

/** Fetch LinkedIn company posts */
async function fetchLinkedInContent(handle: string, orgId: string): Promise<RawBrandContent[]> {
  const items: RawBrandContent[] = [];
  try {
    const channels = await prisma.channel.findMany({
      where: { organizationId: orgId, platform: "LINKEDIN", isActive: true },
      select: { accessToken: true },
    });
    if (channels.length === 0) return [];
    const { accessToken } = channels[0]!;

    const url = `https://api.linkedin.com/rest/posts?q=author&author=urn:li:organization:${handle}&count=10`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "LinkedIn-Version": "202401",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const data = await response.json() as any;

    for (const post of data.elements || []) {
      const text = post.commentary || "";
      if (!text) continue;
      items.push({
        platform: "LINKEDIN",
        contentType: "post",
        content: text.slice(0, 1000),
        contentUrl: null,
        mediaUrl: null,
        authorHandle: handle,
        engagements: 0,
        likes: 0,
        comments: 0,
        shares: 0,
        views: 0,
        hashtags: [],
        publishedAt: new Date(post.createdAt || Date.now()),
      });
    }
  } catch (err) {
    console.warn(`[BrandSync:LinkedIn] Failed for ${handle}:`, err);
  }
  return items;
}

/** Fetch TikTok user videos */
async function fetchTikTokContent(handle: string): Promise<RawBrandContent[]> {
  const clientKey = process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientKey || !clientSecret || !handle) return [];
  const items: RawBrandContent[] = [];
  try {
    const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `client_key=${clientKey}&client_secret=${clientSecret}&grant_type=client_credentials`,
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) return [];
    const { access_token } = await tokenRes.json() as { access_token: string };

    const cleanHandle = handle.replace(/^@/, "");
    const searchRes = await fetch("https://open.tiktokapis.com/v2/research/video/query/", {
      method: "POST",
      headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: { and: [{ operation: "EQ", field_name: "username", field_values: [cleanHandle] }] },
        start_date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
        end_date: new Date().toISOString().split("T")[0],
        max_count: 10,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!searchRes.ok) return [];
    const searchData = await searchRes.json() as any;

    for (const video of searchData.data?.videos || []) {
      const hashtags = (video.hashtag_names || []) as string[];
      items.push({
        platform: "TIKTOK",
        contentType: "video",
        content: video.video_description || "",
        contentUrl: video.share_url || null,
        mediaUrl: null,
        authorHandle: `@${cleanHandle}`,
        engagements: (video.like_count || 0) + (video.comment_count || 0) + (video.share_count || 0),
        likes: video.like_count || 0,
        comments: video.comment_count || 0,
        shares: video.share_count || 0,
        views: video.view_count || 0,
        hashtags,
        publishedAt: new Date(video.create_time * 1000),
      });
    }
  } catch (err) {
    console.warn(`[BrandSync:TikTok] Failed for ${handle}:`, err);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Worker — reuses CAMPAIGN_ANALYTICS_SYNC queue for brand content sync
// ---------------------------------------------------------------------------

export function createBrandContentSyncWorker() {
  const worker = new Worker<CampaignAnalyticsSyncJobData>(
    QUEUE_NAMES.CAMPAIGN_ANALYTICS_SYNC,
    async (job: Job<CampaignAnalyticsSyncJobData>) => {
      const { campaignId, organizationId } = job.data;
      console.log(`[BrandContentSync] Processing campaign ${campaignId || "all"} for org ${organizationId}`);

      // Get all active brand trackers for this org (optionally filtered by campaign)
      const trackers = await prisma.brandTracker.findMany({
        where: {
          organizationId,
          isActive: true,
          ...(campaignId ? { campaignId } : {}),
        },
      });

      let totalContentAdded = 0;
      let totalInfluencersDiscovered = 0;

      for (const tracker of trackers) {
        const allContent: RawBrandContent[] = [];

        // Fetch from all configured platforms in parallel
        const fetchers: Promise<RawBrandContent[]>[] = [];
        if (tracker.twitterHandle) fetchers.push(fetchTwitterContent(tracker.twitterHandle));
        if (tracker.instagramHandle) fetchers.push(fetchInstagramContent(tracker.instagramHandle, organizationId));
        if (tracker.facebookPageId) fetchers.push(fetchFacebookContent(tracker.facebookPageId, organizationId));
        if (tracker.linkedinHandle) fetchers.push(fetchLinkedInContent(tracker.linkedinHandle, organizationId));
        if (tracker.tiktokHandle) fetchers.push(fetchTikTokContent(tracker.tiktokHandle));

        const results = await Promise.all(fetchers.map((f) => f.catch(() => [] as RawBrandContent[])));
        for (const r of results) allContent.push(...r);

        console.log(`[BrandContentSync] Found ${allContent.length} items for brand "${tracker.brandName}"`);

        for (const item of allContent) {
          // Dedup by contentUrl
          if (item.contentUrl) {
            const existing = await prisma.brandContent.findFirst({
              where: { brandTrackerId: tracker.id, contentUrl: item.contentUrl },
            });
            if (existing) continue;
          }

          await prisma.brandContent.create({
            data: {
              brandTrackerId: tracker.id,
              platform: item.platform,
              contentType: item.contentType,
              content: item.content,
              contentUrl: item.contentUrl,
              mediaUrl: item.mediaUrl,
              authorHandle: item.authorHandle,
              engagements: item.engagements,
              likes: item.likes,
              comments: item.comments,
              shares: item.shares,
              views: item.views,
              hashtags: item.hashtags,
              publishedAt: item.publishedAt,
              metadata: item.metadata as any,
            },
          });
          totalContentAdded++;

          // Auto-discover influencers from high-engagement content
          if (item.engagements >= 100 && item.authorHandle) {
            const handle = item.authorHandle.replace(/^@/, "");
            const platform = item.platform.toString();
            const existing = await prisma.influencer.findFirst({
              where: { organizationId, platform, handle },
            });
            if (!existing) {
              await prisma.influencer.create({
                data: {
                  organizationId,
                  name: handle,
                  platform,
                  handle,
                  profileUrl: item.contentUrl,
                  followers: 0,
                  avgEngagement: item.engagements,
                  avgLikes: item.likes,
                  avgComments: item.comments,
                  niche: tracker.brandName,
                  relevanceScore: Math.min(100, item.engagements / 10),
                  discoveredFrom: "brand_tracker",
                  discoveredId: tracker.id,
                  status: "discovered",
                },
              });
              totalInfluencersDiscovered++;
            }
          }
        }

        // Update tracker last sync
        await prisma.brandTracker.update({
          where: { id: tracker.id },
          data: { lastSyncAt: new Date() },
        });
      }

      console.log(`[BrandContentSync] Done. Added ${totalContentAdded} content items, discovered ${totalInfluencersDiscovered} influencers`);
      return { totalContentAdded, totalInfluencersDiscovered };
    },
    {
      connection: createRedisConnection(),
      concurrency: 3,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[BrandContentSync] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
