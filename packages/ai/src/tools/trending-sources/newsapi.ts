import crypto from "crypto";
import type { DiscoveredItem } from "./index";

const NEWSAPI_BASE = "https://newsapi.org/v2/top-headlines";

const TOPIC_TO_CATEGORY: Record<string, string> = {
  tech: "technology",
  technology: "technology",
  business: "business",
  finance: "business",
  science: "science",
  health: "health",
  sports: "sports",
  entertainment: "entertainment",
  general: "general",
};

const REGION_TO_COUNTRY: Record<string, string> = {
  IN: "in",
  US: "us",
  UK: "gb",
  GB: "gb",
};

interface NewsApiArticle {
  source: { id: string | null; name: string };
  author: string | null;
  title: string;
  description: string | null;
  url: string;
  urlToImage: string | null;
  publishedAt: string;
  content: string | null;
}

interface NewsApiResponse {
  status: string;
  totalResults: number;
  articles: NewsApiArticle[];
}

export async function fetchFromNewsApi(
  topic: string = "general",
  region: string = "IN",
  limit: number = 20,
): Promise<DiscoveredItem[]> {
  const apiKey = process.env.NEWSAPI_KEY;
  if (!apiKey) {
    return [];
  }

  const category = TOPIC_TO_CATEGORY[topic.toLowerCase()] ?? "general";
  const country = REGION_TO_COUNTRY[region.toUpperCase()] ?? "us";

  const url = new URL(NEWSAPI_BASE);
  url.searchParams.set("category", category);
  url.searchParams.set("country", country);
  url.searchParams.set("pageSize", String(limit));
  url.searchParams.set("apiKey", apiKey);

  try {
    const response = await fetch(url.toString(), {
      headers: { "User-Agent": "PostAutomation/1.0" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.warn(`NewsAPI fetch failed: HTTP ${response.status}`);
      return [];
    }

    const data = (await response.json()) as NewsApiResponse;

    if (data.status !== "ok" || !data.articles) {
      return [];
    }

    return data.articles
      .filter((a) => a.title && a.title !== "[Removed]")
      .map((article): DiscoveredItem => {
        const sourceId = crypto
          .createHash("md5")
          .update(`newsapi:${article.url}`)
          .digest("hex");

        return {
          sourceType: "NEWSAPI",
          sourceId,
          title: article.title,
          summary: article.description ?? undefined,
          fullText: article.content ?? undefined,
          imageUrl: article.urlToImage ?? undefined,
          sourceUrl: article.url,
          sourceName: article.source.name ?? "NewsAPI",
          topics: [category],
          region: region.toUpperCase(),
          publishedAt: new Date(article.publishedAt),
        };
      });
  } catch (error) {
    console.warn("NewsAPI fetch error:", error);
    return [];
  }
}
