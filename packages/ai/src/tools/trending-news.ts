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
  technology: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB",
  business: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB",
  science: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRE5pYVdRU0FtVnVHZ0pWVXlnQVAB",
  health: "https://news.google.com/rss/topics/CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3QwTlRFU0FtVnVLQUFQAQ",
  sports: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FtVnVHZ0pWVXlnQVAB",
  entertainment: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0FtVnVHZ0pWVXlnQVAB",
};

// India-specific topic feeds
const INDIA_TOPIC_FEEDS: Record<string, string> = {
  tech: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0JXVnVMVWRDR2dKSlRpZ0FQAQ",
  technology: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0JXVnVMVWRDR2dKSlRpZ0FQAQ",
  business: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0JXVnVMVWRDR2dKSlRpZ0FQAQ",
  sports: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0JXVnVMVWRDR2dKSlRpZ0FQAQ",
  entertainment: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0JXVnVMVWRDR2dKSlRpZ0FQAQ",
};

// Region config: locale + country code for Google News
interface RegionConfig {
  hl: string;
  gl: string;
  ceid: string;
}

const REGIONS: Record<string, RegionConfig> = {
  india: { hl: "en-IN", gl: "IN", ceid: "IN:en" },
  us: { hl: "en-US", gl: "US", ceid: "US:en" },
  uk: { hl: "en-GB", gl: "GB", ceid: "GB:en" },
};

// Default to India since that's the primary user base
const DEFAULT_REGION: RegionConfig = { hl: "en-IN", gl: "IN", ceid: "IN:en" };

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

function detectRegion(message: string): RegionConfig {
  const lower = message.toLowerCase();
  if (/\b(india|indian|hindi|bharati?|desi)\b/.test(lower)) return { hl: "en-IN", gl: "IN", ceid: "IN:en" };
  if (/\b(us|usa|america|american|united states)\b/.test(lower)) return { hl: "en-US", gl: "US", ceid: "US:en" };
  if (/\b(uk|britain|british|england)\b/.test(lower)) return { hl: "en-GB", gl: "GB", ceid: "GB:en" };
  return DEFAULT_REGION;
}

export async function fetchTrendingNews(
  topic?: string,
  limit: number = 10,
  region?: RegionConfig
): Promise<TrendingHeadline[]> {
  const r = region || DEFAULT_REGION;
  let feedUrl: string;

  if (!topic) {
    feedUrl = `${GOOGLE_NEWS_BASE}?hl=${r.hl}&gl=${r.gl}&ceid=${r.ceid}`;
  } else {
    const normalizedTopic = topic.toLowerCase().trim();

    // Check if we have a region-specific topic feed
    const isIndia = r.gl === "IN";
    const topicFeeds = isIndia ? INDIA_TOPIC_FEEDS : TOPIC_FEEDS;

    const regionFeed = topicFeeds[normalizedTopic];
    const globalFeed = TOPIC_FEEDS[normalizedTopic];
    if (regionFeed) {
      feedUrl = regionFeed;
    } else if (globalFeed) {
      feedUrl = globalFeed;
    } else {
      feedUrl = `${GOOGLE_NEWS_SEARCH}?q=${encodeURIComponent(topic)}&hl=${r.hl}&gl=${r.gl}&ceid=${r.ceid}`;
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

export function detectTrendingIntent(message: string): { topic?: string; region: RegionConfig } | false {
  const lower = message.toLowerCase();
  const TRENDING_KEYWORDS = [
    "trending", "news", "headlines", "what's happening",
    "latest news", "current events", "breaking news",
    "what's new in", "trending in", "news about",
  ];

  const hasIntent = TRENDING_KEYWORDS.some((kw) => lower.includes(kw));
  if (!hasIntent) return false;

  const region = detectRegion(message);

  // Known topic keywords to extract from anywhere in the message
  const KNOWN_TOPICS = [
    "tech", "technology", "business", "science", "health",
    "sports", "entertainment", "politics", "finance", "ai",
    "crypto", "startup", "startups", "gaming", "automobile",
    "education", "climate", "space",
  ];

  // First try to match a known topic keyword anywhere in the message
  for (const t of KNOWN_TOPICS) {
    if (lower.includes(t)) {
      return { topic: t, region };
    }
  }

  // Then try regex patterns for more complex topic extraction
  const topicPatterns = [
    /(?:trending|news|headlines)\s+(?:in|about|on|for)\s+(.+?)(?:\?|$|\.|,)/i,
    /(?:latest|current|breaking)\s+(.+?)\s+(?:news|headlines|updates)/i,
    /what'?s\s+(?:trending|happening|new)\s+(?:in|with)\s+(.+?)(?:\?|$|\.|,)/i,
    /(?:trending|news)\s+(.+?)(?:\s+(?:post|headline|content|image|card|for)\b)/i,
  ];

  for (const pattern of topicPatterns) {
    const match = message.match(pattern);
    if (match?.[1]) {
      const extracted = match[1].trim();
      // Filter out non-topic words
      if (!["a", "the", "my", "some", "create", "make", "get"].includes(extracted.toLowerCase())) {
        return { topic: extracted, region };
      }
    }
  }

  return { region };
}
