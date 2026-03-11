import { parseRssItems } from "../utils/rss-parser";

export interface TrendingHeadline {
  title: string;
  source: string;
  link: string;
  summary: string;
  published: Date | null;
}

const GOOGLE_NEWS_BASE = "https://news.google.com/rss";
const GOOGLE_NEWS_SEARCH = "https://news.google.com/rss/search";

const TOPIC_FEEDS: Record<string, string> = {
  tech: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB",
  business: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB",
  science: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB",
  health: "https://news.google.com/rss/topics/CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3QwTlRFU0FtVnVLQUFQAQ",
  sports: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FtVnVHZ0pWVXlnQVAB",
  entertainment: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0FtVnVHZ0pWVXlnQVAB",
};

function extractSource(title: string): { headline: string; source: string } {
  const lastDash = title.lastIndexOf(" - ");
  if (lastDash > 0) {
    return {
      headline: title.slice(0, lastDash).trim(),
      source: title.slice(lastDash + 3).trim(),
    };
  }
  return { headline: title, source: "Unknown" };
}

export async function fetchTrendingNews(
  topic?: string,
  limit: number = 10
): Promise<TrendingHeadline[]> {
  let feedUrl: string;

  if (!topic) {
    feedUrl = `${GOOGLE_NEWS_BASE}?hl=en-US&gl=US&ceid=US:en`;
  } else {
    const normalizedTopic = topic.toLowerCase().trim();
    if (TOPIC_FEEDS[normalizedTopic]) {
      feedUrl = TOPIC_FEEDS[normalizedTopic]!;
    } else {
      feedUrl = `${GOOGLE_NEWS_SEARCH}?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en`;
    }
  }

  const response = await fetch(feedUrl, {
    headers: {
      "User-Agent": "PostAutomation/1.0",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Google News RSS fetch failed: HTTP ${response.status}`);
  }

  const xml = await response.text();
  const items = parseRssItems(xml);

  return items.slice(0, limit).map((item) => {
    const { headline, source } = extractSource(item.title);
    return {
      title: headline,
      source,
      link: item.link,
      summary: item.summary,
      published: item.published,
    };
  });
}

export function detectTrendingIntent(message: string): string | boolean {
  const lower = message.toLowerCase();
  const TRENDING_KEYWORDS = [
    "trending", "news", "headlines", "what's happening",
    "latest news", "current events", "breaking news",
    "what's new in", "trending in", "news about",
  ];

  const hasIntent = TRENDING_KEYWORDS.some((kw) => lower.includes(kw));
  if (!hasIntent) return false;

  const topicPatterns = [
    /(?:trending|news|headlines)\s+(?:in|about|on|for)\s+(.+?)(?:\?|$|\.)/i,
    /(?:latest|current|breaking)\s+(.+?)\s+(?:news|headlines|updates)/i,
    /what'?s\s+(?:trending|happening|new)\s+(?:in|with)\s+(.+?)(?:\?|$|\.)/i,
  ];

  for (const pattern of topicPatterns) {
    const match = message.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return true;
}
