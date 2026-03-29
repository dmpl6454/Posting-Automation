/**
 * Web Grounding Utility
 * Searches Google News and web sources to ground AI content in real facts.
 * Prevents hallucination by providing verified, current data.
 */

import { fetchTrendingNews, type TrendingHeadline } from "../tools/trending-news";
import { parseRssItems } from "./rss-parser";

export interface GroundingResult {
  query: string;
  headlines: Array<{ title: string; source: string; link: string; date: string | null }>;
  summary: string;
  grounded: boolean;
}

/**
 * Detect if content needs real-time data grounding.
 * Returns search queries if grounding is needed, null otherwise.
 */
export function detectGroundingNeed(content: string): string[] | null {
  const lower = content.toLowerCase();

  const groundingPatterns = [
    // Lists that need current data
    /top\s+\d+/i,
    /best\s+\d+/i,
    /upcoming\s+\w+/i,
    /latest\s+\w+/i,
    /new\s+(releases?|movies?|films?|shows?|games?|songs?|albums?|books?)/i,
    /\d{4}\s+(movies?|films?|releases?|shows?|games?)/i,
    // Current events
    /trending/i,
    /breaking\s+news/i,
    /recently?\s+(released?|launched?|announced?)/i,
    /this\s+(week|month|year)/i,
    /current(ly)?/i,
    // Factual claims that need verification
    /who\s+(is|was|are|were)/i,
    /when\s+(is|was|will)/i,
    /how\s+much/i,
    /price\s+of/i,
    /score|result|winner|standings/i,
    /box\s*office/i,
    /release\s*date/i,
  ];

  const needsGrounding = groundingPatterns.some((p) => p.test(content));
  if (!needsGrounding) return null;

  // Extract search queries from the content
  const queries: string[] = [];

  // Primary query: the content itself (trimmed)
  const mainQuery = content
    .replace(/[#@]\w+/g, "") // remove hashtags/mentions
    .replace(/https?:\/\/\S+/g, "") // remove URLs
    .replace(/\n+/g, " ")
    .trim()
    .slice(0, 150);

  if (mainQuery.length > 10) queries.push(mainQuery);

  // Additional specific queries for common patterns
  const upcomingMatch = content.match(/upcoming\s+(\w+(?:\s+\w+)?)/i);
  if (upcomingMatch) queries.push(`upcoming ${upcomingMatch[1]} 2025 2026`);

  const topMatch = content.match(/top\s+\d+\s+(.+?)(?:\.|$|\n)/i);
  if (topMatch) queries.push(topMatch[0].trim());

  const latestMatch = content.match(/latest\s+(\w+(?:\s+\w+){0,3})/i);
  if (latestMatch) queries.push(`latest ${latestMatch[1]}`);

  return queries.length > 0 ? queries : null;
}

/**
 * Search Google News for real-time data related to the content.
 */
export async function searchForGrounding(queries: string[]): Promise<GroundingResult[]> {
  const results: GroundingResult[] = [];

  for (const query of queries.slice(0, 3)) {
    try {
      const headlines = await fetchTrendingNews(query, 8);
      results.push({
        query,
        headlines: headlines.map((h) => ({
          title: h.title,
          source: h.source,
          link: h.link,
          date: h.published?.toISOString().split("T")[0] || null,
        })),
        summary: headlines
          .slice(0, 5)
          .map((h) => `- ${h.title} (${h.source})`)
          .join("\n"),
        grounded: headlines.length > 0,
      });
    } catch (e) {
      console.warn(`[Grounding] Search failed for "${query}":`, (e as Error).message);
      results.push({ query, headlines: [], summary: "", grounded: false });
    }
  }

  return results;
}

/**
 * Build a grounding context string for the AI prompt.
 */
export function buildGroundingContext(results: GroundingResult[]): string {
  const validResults = results.filter((r) => r.grounded && r.headlines.length > 0);
  if (validResults.length === 0) return "";

  let context = "\n\n--- VERIFIED REAL-TIME DATA (from Google News) ---\n";
  context += "Use ONLY the following verified information. Do NOT add facts not listed here.\n\n";

  for (const result of validResults) {
    context += `Search: "${result.query}"\n`;
    for (const h of result.headlines) {
      context += `  - ${h.title} (Source: ${h.source}${h.date ? `, Date: ${h.date}` : ""})\n`;
    }
    context += "\n";
  }

  context += "--- END OF VERIFIED DATA ---\n";
  context += "IMPORTANT: Only mention items that appear in the verified data above. Do not invent or guess additional items.\n";

  return context;
}
