/**
 * Celebrity-Brand Detection Worker
 * Ported from standalone Python brand-tracker project.
 *
 * Runs 3 detectors (Ad Library, PR/News RSS, Social Media) every 6 hours
 * to find celebrity-brand partnership signals, enriches with contact info,
 * and creates OutreachLead records for the daily digest.
 *
 * Note: LinkedIn Job scraping (detector #4) is omitted — it required Playwright
 * headless browser which adds heavy Docker deps. Can be added later if needed.
 */

import { prisma } from "@postautomation/db";

// ─── Config ──────────────────────────────────────────────────────────────────

const META_AD_LIBRARY_TOKEN = process.env.META_AD_LIBRARY_ACCESS_TOKEN || "";
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN || "";
const HUNTER_API_KEY = process.env.HUNTER_API_KEY || "";
const GEMINI_API_KEY = process.env.GOOGLE_GEMINI_API_KEY || "";
const OLLAMA_URL = process.env.OLLAMA_BASE_URL || "";
const OLLAMA_MODEL = process.env.OLLAMA_DETECT_MODEL || "llama3.3:70b";
const DEDUP_DAYS = parseInt(process.env.DEDUP_DAYS || "7", 10);

// ─── Celebrity Detection (Gemini primary, Ollama fallback) ──────────────────

interface CelebrityDetection {
  has_celebrity: boolean;
  names: string[];
  confidence: number;
}

const DETECT_SYSTEM = `You are a celebrity and brand endorsement detection system. Your job is to identify if the given content mentions or features a real celebrity in the context of a brand partnership, endorsement, or ambassador deal. Respond only with valid JSON: {"has_celebrity": true/false, "names": ["Name1", "Name2"], "confidence": 0.0-1.0}`;

function parseDetectionResponse(raw: string): CelebrityDetection {
  try {
    // Extract JSON from response (may have markdown wrapping)
    const jsonStr = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(jsonStr);
    return {
      has_celebrity: Boolean(parsed.has_celebrity),
      names: Array.isArray(parsed.names) ? parsed.names.map(String) : [],
      confidence: Number(parsed.confidence) || 0,
    };
  } catch {
    return { has_celebrity: false, names: [], confidence: 0 };
  }
}

async function detectWithGemini(snippet: string): Promise<CelebrityDetection> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${DETECT_SYSTEM}\n\nContent to analyze:\n${snippet}` }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
      }),
      signal: AbortSignal.timeout(30_000),
    }
  );

  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data: any = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  return parseDetectionResponse(text);
}

async function detectWithOllama(snippet: string): Promise<CelebrityDetection> {
  if (!OLLAMA_URL) throw new Error("OLLAMA_BASE_URL not set");

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: `${DETECT_SYSTEM}\n\nContent to analyze:\n${snippet}\n\nReply with JSON only:`,
      stream: false,
      format: "json",
      options: { temperature: 0.1, num_predict: 150 },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data: any = await res.json();
  return parseDetectionResponse(data.response || "{}");
}

async function detectCelebrities(text: string): Promise<CelebrityDetection> {
  const snippet = text.slice(0, 2000);

  // Try Gemini first (cloud, always available), fall back to Ollama
  if (GEMINI_API_KEY) {
    try {
      return await detectWithGemini(snippet);
    } catch (e) {
      console.warn(`[CelebrityDetect] Gemini failed: ${(e as Error).message}, trying Ollama...`);
    }
  }

  if (OLLAMA_URL) {
    try {
      return await detectWithOllama(snippet);
    } catch (e) {
      console.warn(`[CelebrityDetect] Ollama failed: ${(e as Error).message}`);
    }
  }

  console.warn("[CelebrityDetect] No AI provider available for detection");
  return { has_celebrity: false, names: [], confidence: 0 };
}

// ─── Brand Enrichment (Hunter.io) ───────────────────────────────────────────

async function findBrandEmail(domain: string): Promise<string | null> {
  if (!HUNTER_API_KEY || !domain) return null;

  try {
    const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${HUNTER_API_KEY}&limit=5&type=generic`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;

    const data: any = await res.json();
    const emails = data.data?.emails || [];
    const keywords = ["marketing", "brand", "pr", "media", "partner", "collab"];

    for (const email of emails) {
      const addr = email.value || "";
      if (keywords.some((k) => addr.toLowerCase().includes(k))) return addr;
    }
    return emails[0]?.value || null;
  } catch {
    return null;
  }
}

function extractDomain(url: string): string | null {
  const match = url.match(/(?:https?:\/\/)?(?:www\.)?([^\/\s]+)/);
  return match?.[1] || null;
}

// ─── DB Helpers ──────────────────────────────────────────────────────────────

async function brandExistsRecently(brandName: string, orgId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - DEDUP_DAYS * 24 * 60 * 60 * 1000);
  const existing = await prisma.celebrityBrandSignal.findFirst({
    where: {
      organizationId: orgId,
      brandName: { equals: brandName, mode: "insensitive" },
      detectedAt: { gte: cutoff },
    },
    select: { id: true },
  });
  return !!existing;
}

async function saveSignal(params: {
  orgId: string;
  brandName: string;
  celebrityNames: string[];
  signalType: "AD_LIBRARY" | "PR_NEWS" | "SOCIAL_MEDIA" | "JOB_POSTING";
  score: number;
  signalUrl?: string;
  signalData?: Record<string, unknown>;
  brandWebsite?: string;
  brandEmail?: string;
  brandTwitter?: string;
  brandInstagram?: string;
  brandLinkedin?: string;
}): Promise<string> {
  const signal = await prisma.celebrityBrandSignal.create({
    data: {
      organizationId: params.orgId,
      brandName: params.brandName,
      celebrityNames: params.celebrityNames,
      signalType: params.signalType,
      score: params.score,
      signalUrl: params.signalUrl || null,
      signalData: (params.signalData as any) || undefined,
      brandWebsite: params.brandWebsite || null,
      brandEmail: params.brandEmail || null,
      brandTwitter: params.brandTwitter || null,
      brandInstagram: params.brandInstagram || null,
      brandLinkedin: params.brandLinkedin || null,
    },
  });

  // Create pending outreach lead
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  await prisma.outreachLead.create({
    data: {
      signalId: signal.id,
      digestDate: today,
      status: "PENDING",
    },
  });

  return signal.id;
}

// ─── Detector 1: Meta Ad Library ────────────────────────────────────────────

async function runAdLibraryDetector(orgId: string): Promise<number> {
  if (!META_AD_LIBRARY_TOKEN) {
    console.log("[CelebrityDetect:AdLibrary] META_AD_LIBRARY_ACCESS_TOKEN not set, skipping");
    return 0;
  }

  const searchTerms = ["brand ambassador", "celebrity", "official partner", "endorsement"];
  let saved = 0;

  for (const term of searchTerms) {
    try {
      const params = new URLSearchParams({
        access_token: META_AD_LIBRARY_TOKEN,
        ad_type: "ALL",
        ad_active_status: "ACTIVE",
        search_terms: term,
        fields: "id,ad_creative_body,ad_creative_link_caption,page_name,page_id,spend",
        limit: "50",
      });

      const res = await fetch(`https://graph.facebook.com/v19.0/ads_archive?${params}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) continue;

      const json: any = await res.json();
      const ads = json.data || [];

      for (const ad of ads) {
        const pageName = ad.page_name || "";
        const body = ad.ad_creative_body || "";
        const caption = ad.ad_creative_link_caption || "";
        const fullText = `${pageName} ${body} ${caption}`;

        if (!pageName) continue;
        if (await brandExistsRecently(pageName, orgId)) continue;

        const detection = await detectCelebrities(fullText);
        if (!detection.has_celebrity || !detection.names.length) continue;

        const adUrl = `https://www.facebook.com/ads/library/?id=${ad.id || ""}`;

        const signalId = await saveSignal({
          orgId,
          brandName: pageName,
          celebrityNames: detection.names,
          signalType: "AD_LIBRARY",
          score: 3,
          signalUrl: adUrl,
          signalData: { ad_id: ad.id, body_snippet: body.slice(0, 200) },
        });

        console.log(`[CelebrityDetect:AdLibrary] ${pageName} × ${detection.names.join(", ")} → ${signalId}`);
        saved++;
      }
    } catch (e) {
      console.warn(`[CelebrityDetect:AdLibrary] Error for '${term}': ${(e as Error).message}`);
    }
  }

  return saved;
}

// ─── Detector 2: PR / News (RSS) ───────────────────────────────────────────

const ENDORSEMENT_KEYWORDS = [
  "brand ambassador", "endorsement deal", "official partner", "signs with",
  "announces partnership", "celebrity deal", "ambassador for",
];

const BRAND_PATTERNS = [
  /(?:signs with|appointed by|partners with|ambassador for)\s+([A-Z][A-Za-z0-9\s&]+?)(?:\s+as|\s+to|\s*,|\s*\.)/,
  /([A-Z][A-Za-z0-9\s&]+?)\s+(?:appoints|names|announces|welcomes)\s+[A-Z]/,
  /([A-Z][A-Za-z0-9\s&]{2,30})\s+(?:brand ambassador|official partner)/,
];

function extractBrandName(title: string, summary: string): string | null {
  const combined = `${title} ${summary}`;
  for (const pat of BRAND_PATTERNS) {
    const match = combined.match(pat);
    if (match?.[1] && match[1].trim().length > 2) return match[1].trim();
  }
  return null;
}

async function runPRNewsDetector(orgId: string): Promise<number> {
  let saved = 0;

  const queries = [
    "brand ambassador celebrity endorsement",
    "celebrity signs deal brand ambassador",
    "celebrity official partner brand",
    "bollywood brand ambassador deal",
    "cricket brand endorsement",
  ];

  // We'll use a lightweight RSS parser approach with fetch + regex
  for (const query of queries) {
    try {
      const encoded = encodeURIComponent(query);
      const url = `https://news.google.com/rss/search?q=${encoded}&hl=en-IN&gl=IN&ceid=IN:en`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;

      const xml = await res.text();
      const items = parseRssItems(xml);

      for (const item of items.slice(0, 20)) {
        const text = `${item.title} ${item.description}`.toLowerCase();
        if (!ENDORSEMENT_KEYWORDS.some((kw) => text.includes(kw))) continue;

        const detection = await detectCelebrities(`${item.title} ${item.description}`);
        if (!detection.has_celebrity) continue;

        const brandName = extractBrandName(item.title, item.description);
        if (!brandName) continue;
        if (await brandExistsRecently(brandName, orgId)) continue;

        const signalId = await saveSignal({
          orgId,
          brandName,
          celebrityNames: detection.names,
          signalType: "PR_NEWS",
          score: 2,
          signalUrl: item.link,
          signalData: { title: item.title, source: "google_news" },
        });

        console.log(`[CelebrityDetect:PRNews] ${brandName} × ${detection.names.join(", ")} → ${signalId}`);
        saved++;
      }
    } catch (e) {
      console.warn(`[CelebrityDetect:PRNews] Error for '${query}': ${(e as Error).message}`);
    }
  }

  // PRNewswire RSS
  try {
    const res = await fetch("https://www.prnewswire.com/rss/news-releases-list.rss", {
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const xml = await res.text();
      const items = parseRssItems(xml);

      for (const item of items.slice(0, 30)) {
        const text = `${item.title} ${item.description}`.toLowerCase();
        if (!ENDORSEMENT_KEYWORDS.some((kw) => text.includes(kw))) continue;

        const detection = await detectCelebrities(`${item.title} ${item.description}`);
        if (!detection.has_celebrity) continue;

        const brandName = extractBrandName(item.title, item.description);
        if (!brandName) continue;
        if (await brandExistsRecently(brandName, orgId)) continue;

        const signalId = await saveSignal({
          orgId,
          brandName,
          celebrityNames: detection.names,
          signalType: "PR_NEWS",
          score: 2,
          signalUrl: item.link,
          signalData: { title: item.title, source: "prnewswire" },
        });

        console.log(`[CelebrityDetect:PRNews] PRNewswire: ${brandName} × ${detection.names.join(", ")} → ${signalId}`);
        saved++;
      }
    }
  } catch (e) {
    console.warn(`[CelebrityDetect:PRNews] PRNewswire error: ${(e as Error).message}`);
  }

  return saved;
}

// ─── Detector 3: Social Media (Twitter/X) ───────────────────────────────────

async function runSocialMediaDetector(orgId: string): Promise<number> {
  if (!TWITTER_BEARER_TOKEN) {
    console.log("[CelebrityDetect:Social] TWITTER_BEARER_TOKEN not set, skipping");
    return 0;
  }

  const queries = [
    "#brandambassador #ad -is:retweet",
    "#officialpartner #sponsored lang:en -is:retweet",
    "brand ambassador (bollywood OR cricket OR celebrity) -is:retweet",
  ];

  let saved = 0;

  for (const query of queries) {
    try {
      const params = new URLSearchParams({
        query,
        max_results: "20",
        "tweet.fields": "author_id,created_at,text",
        expansions: "author_id",
        "user.fields": "name,username,verified,public_metrics",
      });

      const res = await fetch(`https://api.twitter.com/2/tweets/search/recent?${params}`, {
        headers: { Authorization: `Bearer ${TWITTER_BEARER_TOKEN}` },
        signal: AbortSignal.timeout(15_000),
      });

      if (res.status === 429) {
        console.warn("[CelebrityDetect:Social] Twitter rate limit hit, stopping");
        break;
      }
      if (!res.ok) continue;

      const data: any = await res.json();
      const usersMap = new Map<string, any>();
      for (const u of data.includes?.users || []) {
        usersMap.set(u.id, u);
      }

      for (const tweet of data.data || []) {
        const text = tweet.text || "";
        const author = usersMap.get(tweet.author_id) || {};
        const authorName = author.name || "";
        const username = author.username || "";
        const isVerified = author.verified || false;
        const followers = author.public_metrics?.followers_count || 0;

        if (followers < 1000 && !isVerified) continue;

        const detection = await detectCelebrities(text);
        if (!detection.has_celebrity || !detection.names.length) continue;

        const brandName = authorName || username;
        if (!brandName) continue;
        if (await brandExistsRecently(brandName, orgId)) continue;

        const tweetUrl = `https://twitter.com/${username}/status/${tweet.id}`;

        const signalId = await saveSignal({
          orgId,
          brandName,
          celebrityNames: detection.names,
          signalType: "SOCIAL_MEDIA",
          score: 2,
          signalUrl: tweetUrl,
          signalData: { tweet_id: tweet.id, text: text.slice(0, 300) },
          brandTwitter: `@${username}`,
        });

        console.log(`[CelebrityDetect:Social] ${brandName} × ${detection.names.join(", ")} → ${signalId}`);
        saved++;
      }
    } catch (e) {
      console.warn(`[CelebrityDetect:Social] Error for query: ${(e as Error).message}`);
    }
  }

  return saved;
}

// ─── Lightweight RSS Parser ─────────────────────────────────────────────────

interface RssItem {
  title: string;
  description: string;
  link: string;
}

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const content = match[1]!;
    const title = content.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1] || "";
    const description = content.match(/<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/)?.[1] || "";
    const link = content.match(/<link>(.*?)<\/link>/)?.[1] || "";

    items.push({
      title: title.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"'),
      description: description.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
      link,
    });
  }

  return items;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Run all celebrity-brand detectors for all organizations.
 * Called by cron every 6 hours.
 */
export async function runCelebrityDetectors(): Promise<void> {
  console.log("[CelebrityDetect] === Starting celebrity-brand detection scan ===");

  // Get all organizations (most deployments have just one)
  const orgs = await prisma.organization.findMany({
    select: { id: true, name: true },
  });

  for (const org of orgs) {
    console.log(`[CelebrityDetect] Scanning for org: ${org.name} (${org.id})`);

    let total = 0;

    try {
      const adLibCount = await runAdLibraryDetector(org.id);
      console.log(`[CelebrityDetect:AdLibrary] ${adLibCount} new signals`);
      total += adLibCount;
    } catch (e) {
      console.error(`[CelebrityDetect:AdLibrary] Crashed: ${(e as Error).message}`);
    }

    try {
      const prCount = await runPRNewsDetector(org.id);
      console.log(`[CelebrityDetect:PRNews] ${prCount} new signals`);
      total += prCount;
    } catch (e) {
      console.error(`[CelebrityDetect:PRNews] Crashed: ${(e as Error).message}`);
    }

    try {
      const socialCount = await runSocialMediaDetector(org.id);
      console.log(`[CelebrityDetect:Social] ${socialCount} new signals`);
      total += socialCount;
    } catch (e) {
      console.error(`[CelebrityDetect:Social] Crashed: ${(e as Error).message}`);
    }

    console.log(`[CelebrityDetect] Org ${org.name}: ${total} total new signals`);
  }

  console.log("[CelebrityDetect] === Detection scan complete ===");
}
