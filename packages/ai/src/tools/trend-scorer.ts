// Source credibility lookup table
const SOURCE_CREDIBILITY: Record<string, number> = {
  "Reuters": 95, "AP News": 95, "BBC": 90, "CNN": 85, "The Guardian": 85,
  "The New York Times": 90, "Bloomberg": 90, "TechCrunch": 80, "The Verge": 80,
  "Wired": 80, "Ars Technica": 80, "NDTV": 75, "Times of India": 75,
  "Hindustan Times": 75, "The Hindu": 80, "India Today": 75,
  "Twitter/X Trends": 60, "default": 50,
};

export function calculateRecencyScore(publishedAt: Date): number {
  const hoursAgo = (Date.now() - publishedAt.getTime()) / (1000 * 60 * 60);
  if (hoursAgo < 1) return 100;
  if (hoursAgo < 3) return 80;
  if (hoursAgo < 6) return 50;
  if (hoursAgo < 12) return 30;
  if (hoursAgo < 24) return 10;
  return 0;
}

export function calculateSourceCredibility(sourceName: string): number {
  // Check exact match first
  if (SOURCE_CREDIBILITY[sourceName] !== undefined) {
    return SOURCE_CREDIBILITY[sourceName]!;
  }

  // Check partial matches
  const lowerSource = sourceName.toLowerCase();
  for (const [key, value] of Object.entries(SOURCE_CREDIBILITY)) {
    if (key === "default") continue;
    if (lowerSource.includes(key.toLowerCase()) || key.toLowerCase().includes(lowerSource)) {
      return value;
    }
  }

  // Reddit sources
  if (/^r\//.test(sourceName) || lowerSource.includes("reddit")) {
    return 55;
  }

  return SOURCE_CREDIBILITY["default"]!;
}

export function calculateViralSignal(viralSignal?: number, sourceType?: string): number {
  if (viralSignal === undefined) return 30;

  if (sourceType === "reddit") {
    if (viralSignal > 10_000) return 100;
    if (viralSignal > 5_000) return 80;
    if (viralSignal > 1_000) return 60;
    if (viralSignal > 100) return 40;
    return 20;
  }

  if (sourceType === "twitter") {
    if (viralSignal > 100_000) return 100;
    if (viralSignal > 50_000) return 80;
    if (viralSignal > 10_000) return 60;
    if (viralSignal > 1_000) return 40;
    return 20;
  }

  return 30;
}

export function calculateNicheRelevance(itemTopics: string[], agentTopics: string[]): number {
  if (itemTopics.length === 0 || agentTopics.length === 0) return 20;

  const itemSet = new Set(itemTopics.map((t) => t.toLowerCase()));
  const agentSet = new Set(agentTopics.map((t) => t.toLowerCase()));

  let overlap = 0;
  for (const topic of itemSet) {
    if (agentSet.has(topic)) overlap++;
  }

  const total = Math.max(itemSet.size, agentSet.size);
  return Math.round((overlap / total) * 100);
}

export function calculateTrendScore(params: {
  publishedAt: Date;
  sourceName: string;
  viralSignal?: number;
  sourceType?: string;
  itemTopics: string[];
  agentTopics: string[];
}): number {
  const recency = calculateRecencyScore(params.publishedAt);
  const credibility = calculateSourceCredibility(params.sourceName);
  const viral = calculateViralSignal(params.viralSignal, params.sourceType);
  const relevance = calculateNicheRelevance(params.itemTopics, params.agentTopics);

  return Math.round(recency * 0.3 + credibility * 0.2 + viral * 0.2 + relevance * 0.3);
}
