/**
 * Structured reference-card classification (Component 3). A gpt-4o-mini vision
 * call returns a CardSpec-shaped HINT: which blocks are present + theme/accent,
 * NOT just a single template id. Used to auto-select a preset + pre-fill controls
 * in the Repurpose UI (locked-with-Edit). Fails graceful → null; the caller
 * defaults to `news_caption` so generation is never blocked.
 *
 * Layout detection only. The prose `describeImageStyle` descriptor still feeds AI
 * photo prompts when AI is on.
 */
import { safeColor } from "./creative-templates";

export type PresetId =
  | "news_caption"
  | "news_inset"
  | "infographic_stats"
  | "marketing_minimal"
  | "tweet_card"
  | "photo_grid"
  | "title_cover"
  | "listicle_body";

const PRESET_IDS: readonly PresetId[] = [
  "news_caption", "news_inset", "infographic_stats", "marketing_minimal",
  "tweet_card", "photo_grid", "title_cover", "listicle_body",
];

export interface CardHint {
  preset: PresetId;
  blocks: {
    logo?: boolean;
    circularInset?: number;
    labelChip?: number;
    tweetHeader?: boolean;
    statCards?: number;
    captionCount?: number;
  };
  theme: "light" | "dark";
  accentColor: string; // #hex, safeColor-sanitized
  confidence: number;  // 0–1
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const countOrUndef = (v: unknown): number | undefined => {
  const n = num(v, -1);
  return n >= 0 ? Math.round(n) : undefined;
};

/** Parse the vision model's text into a sanitized CardHint, or null. Pure + exported for tests. */
export function parseCardHint(raw: string): CardHint | null {
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: any;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!PRESET_IDS.includes(obj?.preset)) return null;
  const b = obj.blocks ?? {};
  return {
    preset: obj.preset as PresetId,
    blocks: {
      logo: b.logo === true,
      circularInset: countOrUndef(b.circularInset),
      labelChip: countOrUndef(b.labelChip),
      tweetHeader: b.tweetHeader === true,
      statCards: countOrUndef(b.statCards),
      captionCount: countOrUndef(b.captionCount),
    },
    theme: obj.theme === "dark" ? "dark" : "light",
    accentColor: safeColor(typeof obj.accentColor === "string" ? obj.accentColor : undefined),
    confidence: clamp01(num(obj.confidence, 0)),
  };
}

const CLASSIFY_PROMPT = `You are a layout detector for Instagram-style social cards.
Look at the reference image and return ONLY JSON describing its layout:
{
  "preset": one of ["news_caption","news_inset","infographic_stats","marketing_minimal","tweet_card","photo_grid","title_cover","listicle_body"],
  "blocks": { "logo": bool, "circularInset": int count, "labelChip": int count, "tweetHeader": bool, "statCards": int count, "captionCount": int count },
  "theme": "light" or "dark",
  "accentColor": dominant accent as #rrggbb,
  "confidence": 0..1
}
Pick the SINGLE closest preset. Return ONLY the JSON, no prose.`;

/**
 * Classify a reference image to a preset + block hint via gpt-4o-mini vision.
 * Returns null on any failure (missing key, network, unparseable) so the caller
 * defaults to `news_caption` and never blocks generation.
 */
export async function classifyCard(
  imageBase64: string,
  imageMimeType: string,
): Promise<CardHint | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: CLASSIFY_PROMPT },
              { type: "image_url", image_url: { url: `data:${imageMimeType};base64,${imageBase64}` } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[classifyCard] vision call failed: ${res.status}`);
      return null;
    }
    const data: any = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === "string" ? parseCardHint(text) : null;
  } catch (e) {
    console.warn(`[classifyCard] error:`, (e as Error).message);
    return null;
  }
}
