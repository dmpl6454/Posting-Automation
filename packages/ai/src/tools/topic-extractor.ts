import crypto from "crypto";

const TOPIC_KEYWORDS: Record<string, string[]> = {
  tech: [
    "software", "hardware", "app", "startup", "silicon valley", "developer",
    "programming", "code", "api", "cloud", "saas", "platform", "gadget",
    "smartphone", "laptop", "tablet", "internet", "digital", "innovation",
    "computing",
  ],
  business: [
    "market", "stock", "revenue", "profit", "ceo", "company", "corporation",
    "merger", "acquisition", "ipo", "investment", "economy", "trade",
    "commerce", "enterprise", "growth", "earnings", "valuation", "funding",
    "venture",
  ],
  science: [
    "research", "study", "experiment", "discovery", "scientist", "laboratory",
    "physics", "chemistry", "biology", "astronomy", "nasa", "space",
    "quantum", "molecule", "genome", "evolution", "theory", "particle",
    "climate change", "environmental",
  ],
  health: [
    "medical", "doctor", "hospital", "disease", "treatment", "vaccine",
    "mental health", "wellness", "nutrition", "fitness", "pharmaceutical",
    "fda", "clinical", "patient", "therapy", "diagnosis", "surgery",
    "pandemic", "virus", "healthcare",
  ],
  sports: [
    "game", "match", "player", "team", "championship", "league", "score",
    "tournament", "coach", "athlete", "football", "basketball", "cricket",
    "tennis", "soccer", "olympic", "nfl", "nba", "fifa", "ipl",
  ],
  entertainment: [
    "movie", "film", "actor", "actress", "music", "album", "concert",
    "celebrity", "hollywood", "bollywood", "netflix", "streaming", "tv show",
    "series", "award", "grammy", "oscar", "box office", "release",
    "premiere",
  ],
  politics: [
    "government", "election", "president", "prime minister", "congress",
    "parliament", "senate", "legislation", "law", "policy", "democrat",
    "republican", "vote", "campaign", "diplomacy", "sanctions", "bilateral",
    "geopolitics", "regulation", "bill",
  ],
  crypto: [
    "bitcoin", "ethereum", "blockchain", "cryptocurrency", "token", "defi",
    "nft", "mining", "wallet", "exchange", "altcoin", "web3", "dao",
    "stablecoin", "binance", "coinbase", "solana", "ledger", "halving",
    "memecoin",
  ],
  gaming: [
    "video game", "console", "playstation", "xbox", "nintendo", "steam",
    "esports", "gamer", "multiplayer", "rpg", "fps", "indie game",
    "twitch", "streamer", "dlc", "battle royale", "mmorpg", "patch",
    "update", "graphics card",
  ],
};

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "as", "was", "are", "be",
  "has", "had", "have", "will", "would", "could", "should", "may",
  "might", "that", "this", "these", "those", "not", "no", "so", "if",
  "than", "too", "very", "just", "about", "up", "out", "do", "did",
  "does", "been", "being", "its", "also", "into", "over", "after",
  "before", "between", "under", "again", "more", "most", "other", "some",
  "such", "only", "own", "same", "can", "how", "all", "each", "which",
  "their", "there", "then", "when", "what", "who", "whom", "why", "where",
  "he", "she", "they", "we", "you", "me", "him", "her", "us", "them",
  "my", "your", "his", "our",
]);

export function extractTopics(title: string, summary?: string): string[] {
  const text = `${title} ${summary ?? ""}`.toLowerCase();
  const matched: string[] = [];

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        matched.push(topic);
        break;
      }
    }
  }

  return matched.length > 0 ? matched : ["general"];
}

export function generateTitleHash(title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((word) => !STOP_WORDS.has(word))
    .sort()
    .join(" ");

  return crypto.createHash("md5").update(normalized).digest("hex");
}
