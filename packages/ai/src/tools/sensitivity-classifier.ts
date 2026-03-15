const HIGH_KEYWORDS = [
  "killed", "dead", "death", "murder", "war", "attack", "terrorism",
  "bomb", "shooting", "violence", "riot", "protest", "arrest",
  "election", "president", "prime minister", "politician", "political",
  "parliament", "congress", "vote", "scandal", "corruption",
  "religious", "communal", "caste", "rape", "abuse",
];

const MEDIUM_KEYWORDS = [
  "controversy", "opinion", "debate", "criticism", "backlash",
  "accused", "allegation", "dispute", "conflict", "crisis",
  "layoff", "fired", "resign", "ban", "boycott",
];

export type Sensitivity = "LOW" | "MEDIUM" | "HIGH";

export function classifySensitivity(title: string, summary?: string): Sensitivity {
  const text = `${title} ${summary ?? ""}`.toLowerCase();

  for (const keyword of HIGH_KEYWORDS) {
    if (text.includes(keyword)) return "HIGH";
  }

  for (const keyword of MEDIUM_KEYWORDS) {
    if (text.includes(keyword)) return "MEDIUM";
  }

  return "LOW";
}
