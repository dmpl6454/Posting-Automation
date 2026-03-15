export interface DiscoveredItem {
  sourceType: "GOOGLE_NEWS" | "NEWSAPI" | "REDDIT" | "TWITTER" | "RSS";
  sourceId: string;
  title: string;
  summary?: string;
  fullText?: string;
  imageUrl?: string;
  sourceUrl: string;
  sourceName: string;
  topics: string[];
  region: string;
  publishedAt: Date;
  viralSignal?: number;
}

export { fetchFromNewsApi } from "./newsapi";
export { fetchFromReddit } from "./reddit";
export { fetchFromTwitterTrends } from "./twitter-trends";
