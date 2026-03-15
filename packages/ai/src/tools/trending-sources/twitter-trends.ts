import crypto from "crypto";
import type { DiscoveredItem } from "./index";

const TWITTER_TRENDS_URL = "https://api.twitter.com/1.1/trends/place.json";

const REGION_TO_WOEID: Record<string, number> = {
  IN: 23424848,
  US: 23424977,
  UK: 23424975,
  GB: 23424975,
};

interface TwitterTrend {
  name: string;
  url: string;
  query: string;
  tweet_volume: number | null;
}

interface TwitterTrendsResponse {
  trends: TwitterTrend[];
  as_of: string;
  locations: Array<{ name: string; woeid: number }>;
}

export async function fetchFromTwitterTrends(
  region: string = "US",
  limit: number = 20,
): Promise<DiscoveredItem[]> {
  const bearerToken = process.env.TWITTER_BEARER_TOKEN;
  if (!bearerToken) {
    return [];
  }

  const woeid = REGION_TO_WOEID[region.toUpperCase()] ?? REGION_TO_WOEID.US;
  const url = `${TWITTER_TRENDS_URL}?id=${woeid}`;

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "User-Agent": "PostAutomation/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.warn(`Twitter trends fetch failed: HTTP ${response.status}`);
      return [];
    }

    const data = (await response.json()) as TwitterTrendsResponse[];

    if (!data?.[0]?.trends) {
      return [];
    }

    const trends = data[0].trends;
    const asOf = new Date(data[0].as_of);
    const locationName = data[0].locations?.[0]?.name ?? region;

    return trends.slice(0, limit).map((trend): DiscoveredItem => {
      const sourceId = crypto
        .createHash("md5")
        .update(`twitter:${trend.name}:${asOf.toISOString()}`)
        .digest("hex");

      return {
        sourceType: "TWITTER",
        sourceId,
        title: trend.name,
        sourceUrl: trend.url,
        sourceName: `Twitter Trends (${locationName})`,
        topics: [], // classified later by topic extractor
        region: region.toUpperCase(),
        publishedAt: asOf,
        viralSignal: trend.tweet_volume ?? undefined,
      };
    });
  } catch (error) {
    console.warn("Twitter trends fetch error:", error);
    return [];
  }
}
