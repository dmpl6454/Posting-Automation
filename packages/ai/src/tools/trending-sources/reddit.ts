import crypto from "crypto";
import type { DiscoveredItem } from "./index";

const REDDIT_OAUTH_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_API_BASE = "https://oauth.reddit.com";

const NICHE_TO_SUBREDDITS: Record<string, string[]> = {
  tech: ["technology", "gadgets", "programming"],
  technology: ["technology", "gadgets", "programming"],
  business: ["business", "entrepreneur", "smallbusiness"],
  finance: ["finance", "investing", "economics"],
  science: ["science", "space", "askscience"],
  health: ["health", "fitness", "nutrition"],
  sports: ["sports", "nba", "soccer"],
  entertainment: ["entertainment", "movies", "television"],
  gaming: ["gaming", "pcgaming", "Games"],
  crypto: ["cryptocurrency", "bitcoin", "CryptoMarkets"],
  ai: ["artificial", "MachineLearning", "ChatGPT"],
  politics: ["politics", "worldnews", "geopolitics"],
};

interface RedditPost {
  data: {
    id: string;
    title: string;
    selftext: string;
    url: string;
    permalink: string;
    subreddit: string;
    thumbnail: string;
    ups: number;
    created_utc: number;
    stickied: boolean;
    preview?: {
      images?: Array<{ source: { url: string } }>;
    };
  };
}

interface RedditListingResponse {
  data: {
    children: RedditPost[];
  };
}

async function getRedditAccessToken(
  clientId: string,
  clientSecret: string,
): Promise<string | null> {
  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const response = await fetch(REDDIT_OAUTH_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "PostAutomation/1.0",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as { access_token: string };
    return data.access_token;
  } catch {
    return null;
  }
}

export async function fetchFromReddit(
  niche: string = "tech",
  region: string = "US",
  sort: "hot" | "rising" = "hot",
  limit: number = 20,
): Promise<DiscoveredItem[]> {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return [];
  }

  const token = await getRedditAccessToken(clientId, clientSecret);
  if (!token) {
    console.warn("Reddit: failed to obtain access token");
    return [];
  }

  const subreddits = NICHE_TO_SUBREDDITS[niche.toLowerCase()] ?? ["popular"];
  const items: DiscoveredItem[] = [];

  for (const subreddit of subreddits) {
    try {
      const url = `${REDDIT_API_BASE}/r/${subreddit}/${sort}?limit=${limit}`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "PostAutomation/1.0",
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        console.warn(`Reddit fetch failed for r/${subreddit}: HTTP ${response.status}`);
        continue;
      }

      const data = (await response.json()) as RedditListingResponse;

      for (const post of data.data.children) {
        const p = post.data;

        // Skip stickied posts
        if (p.stickied) continue;

        const sourceId = crypto
          .createHash("md5")
          .update(`reddit:${p.id}`)
          .digest("hex");

        const imageUrl =
          p.preview?.images?.[0]?.source?.url?.replace(/&amp;/g, "&") ?? undefined;

        items.push({
          sourceType: "REDDIT",
          sourceId,
          title: p.title,
          summary: p.selftext ? p.selftext.slice(0, 500) : undefined,
          imageUrl,
          sourceUrl: `https://reddit.com${p.permalink}`,
          sourceName: `r/${p.subreddit}`,
          topics: [niche.toLowerCase()],
          region: region.toUpperCase(),
          publishedAt: new Date(p.created_utc * 1000),
          viralSignal: p.ups,
        });
      }
    } catch (error) {
      console.warn(`Reddit fetch error for r/${subreddit}:`, error);
    }
  }

  return items;
}
