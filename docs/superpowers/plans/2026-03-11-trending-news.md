# Trending News in AI Chat — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time Google News RSS trending headlines into the AI chat, with auto-drafted social media posts and news card image generation (with org logo support).

**Architecture:** On-demand server-side fetch — when the user asks about trending news in the chat, the streaming API route detects the intent, fetches Google News RSS in real-time, parses headlines, and injects them into the AI's context. The AI presents headlines, auto-drafts a post, and triggers news image generation. No new DB tables; images stored via existing Media model.

**Tech Stack:** Google News RSS (free, no API key), existing RSS parser (extracted to shared util), Puppeteer for HTML→PNG news cards, DALL-E for AI-generated images, existing LangChain streaming.

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `packages/ai/src/utils/rss-parser.ts` | Shared RSS XML parser (extracted from worker) |
| Create | `packages/ai/src/tools/trending-news.ts` | Fetch Google News RSS + parse into structured headlines |
| Create | `packages/ai/src/tools/news-card-template.ts` | HTML/CSS template function for news card images |
| Create | `packages/ai/src/tools/news-image-generator.ts` | Render news card HTML→PNG via Puppeteer, or call DALL-E |
| Modify | `apps/worker/src/workers/rss-sync.worker.ts` | Import parser from shared util instead of inline |
| Modify | `packages/ai/src/chains/chat-agent.chain.ts` | Extend ChatContext with trendingNews + orgLogo, extend ChatAgentAction types |
| Modify | `packages/ai/src/prompts/chat-agent.prompt.ts` | Add trending news capability + image generation + posting confirmation flow |
| Modify | `apps/web/app/api/chat/stream/route.ts` | Detect trending intent, fetch news, load org logo, pass enriched context |
| Modify | `packages/api/src/routers/chat.router.ts` | Handle `generate_news_image` action type |
| Modify | `apps/web/components/chat/MessageBubble.tsx` | Render news image inline + "Generate Image" button |
| Modify | `packages/ai/src/index.ts` | Export new functions |
| Modify | `packages/ai/package.json` | Add puppeteer dependency |

---

## Chunk 1: Shared RSS Parser + Trending News Fetcher

### Task 1: Extract shared RSS parser from worker

**Files:**
- Create: `packages/ai/src/utils/rss-parser.ts`
- Modify: `apps/worker/src/workers/rss-sync.worker.ts`

- [ ] **Step 1: Create the shared RSS parser module**

Create `packages/ai/src/utils/rss-parser.ts` with the `parseRssItems` and `extractTag` functions extracted from the worker. These are pure functions with no dependencies.

```typescript
// packages/ai/src/utils/rss-parser.ts

export interface RssItem {
  guid: string;
  title: string;
  link: string;
  summary: string;
  published: Date | null;
}

export function extractTag(xml: string, tag: string): string {
  // Handle CDATA sections
  const cdataRegex = new RegExp(
    `<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`,
    "i"
  );
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch && cdataMatch[1]) return cdataMatch[1].trim();

  // Handle regular text content
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const match = xml.match(regex);
  if (match && match[1]) {
    return match[1].replace(/<[^>]+>/g, "").trim();
  }
  return "";
}

export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];

  // Try RSS 2.0 <item> elements first
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1] ?? "";
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const guid = extractTag(block, "guid") || link || title;
    const summary =
      extractTag(block, "description") ||
      extractTag(block, "content:encoded") ||
      "";
    const pubDate = extractTag(block, "pubDate");

    if (guid && title) {
      items.push({
        guid,
        title,
        link: link || "",
        summary: summary.slice(0, 2000),
        published: pubDate ? new Date(pubDate) : null,
      });
    }
  }

  // If no RSS items found, try Atom <entry> elements
  if (items.length === 0) {
    const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
    while ((match = entryRegex.exec(xml)) !== null) {
      const block = match[1] ?? "";
      const title = extractTag(block, "title");
      const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/);
      const link = linkMatch ? (linkMatch[1] ?? "") : extractTag(block, "link");
      const guid = extractTag(block, "id") || link || title;
      const summary =
        extractTag(block, "summary") ||
        extractTag(block, "content") ||
        "";
      const updated = extractTag(block, "updated") || extractTag(block, "published");

      if (guid && title) {
        items.push({
          guid,
          title,
          link: link || "",
          summary: summary.slice(0, 2000),
          published: updated ? new Date(updated) : null,
        });
      }
    }
  }

  return items;
}
```

- [ ] **Step 2: Update the worker to import from shared util**

Replace inline `RssItem` interface, `parseRssItems`, and `extractTag` in `apps/worker/src/workers/rss-sync.worker.ts` with imports from the shared module. Remove lines 5-69 (the inline definitions) and add:

```typescript
import { parseRssItems, type RssItem } from "@postautomation/ai/src/utils/rss-parser";
```

Keep everything else in the worker unchanged.

- [ ] **Step 3: Verify the worker still builds**

Run: `cd /Users/sudhanshu6454/Posting\ Automation && pnpm build`
Expected: No TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add packages/ai/src/utils/rss-parser.ts apps/worker/src/workers/rss-sync.worker.ts
git commit -m "refactor: extract shared RSS parser from worker into @postautomation/ai"
```

---

### Task 2: Create trending news fetcher

**Files:**
- Create: `packages/ai/src/tools/trending-news.ts`

- [ ] **Step 1: Create the trending news fetcher**

```typescript
// packages/ai/src/tools/trending-news.ts

import { parseRssItems, type RssItem } from "../utils/rss-parser";

export interface TrendingHeadline {
  title: string;
  source: string;
  link: string;
  summary: string;
  published: Date | null;
}

const GOOGLE_NEWS_BASE = "https://news.google.com/rss";
const GOOGLE_NEWS_SEARCH = "https://news.google.com/rss/search";

// Named topic feeds from Google News
const TOPIC_FEEDS: Record<string, string> = {
  tech: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB",
  business: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB",
  science: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB",
  health: "https://news.google.com/rss/topics/CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3QwTlRFU0FtVnVLQUFQAQ",
  sports: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FtVnVHZ0pWVXlnQVAB",
  entertainment: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0FtVnVHZ0pWVXlnQVAB",
};

/**
 * Extract source name from Google News title format: "Headline - Source Name"
 */
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

/**
 * Fetch trending news from Google News RSS.
 * @param topic - Optional topic keyword (e.g. "tech", "AI", "business")
 * @param limit - Max headlines to return (default 10)
 */
export async function fetchTrendingNews(
  topic?: string,
  limit: number = 10
): Promise<TrendingHeadline[]> {
  let feedUrl: string;

  if (!topic) {
    feedUrl = `${GOOGLE_NEWS_BASE}?hl=en-US&gl=US&ceid=US:en`;
  } else {
    const normalizedTopic = topic.toLowerCase().trim();
    // Check if topic matches a named feed
    if (TOPIC_FEEDS[normalizedTopic]) {
      feedUrl = TOPIC_FEEDS[normalizedTopic]!;
    } else {
      // Search feed for custom topics
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

/**
 * Detect if a user message is asking about trending news.
 * Returns the extracted topic if found, or true for general news, or false if no intent.
 */
export function detectTrendingIntent(message: string): string | boolean {
  const lower = message.toLowerCase();
  const TRENDING_KEYWORDS = [
    "trending", "news", "headlines", "what's happening",
    "latest news", "current events", "breaking news",
    "what's new in", "trending in", "news about",
  ];

  const hasIntent = TRENDING_KEYWORDS.some((kw) => lower.includes(kw));
  if (!hasIntent) return false;

  // Try to extract topic: "trending in tech", "news about AI", "latest tech news"
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

  return true; // General trending, no specific topic
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/ai/src/tools/trending-news.ts
git commit -m "feat: add Google News RSS trending news fetcher with intent detection"
```

---

## Chunk 2: News Card Image Generation

### Task 3: Create news card HTML template

**Files:**
- Create: `packages/ai/src/tools/news-card-template.ts`

- [ ] **Step 1: Create the HTML/CSS template**

```typescript
// packages/ai/src/tools/news-card-template.ts

export interface NewsCardOptions {
  headline: string;
  source: string;
  sourceUrl?: string;
  logoUrl?: string;       // org logo to embed
  handle?: string;        // e.g. "@yourhandle"
  date?: string;          // formatted date string
  platform: "instagram" | "twitter" | "linkedin" | "facebook";
  gradientFrom?: string;  // hex color, default "#1a1a2e"
  gradientTo?: string;    // hex color, default "#16213e"
  accentColor?: string;   // hex color, default "#e94560"
}

function getDimensions(platform: string): { width: number; height: number } {
  switch (platform) {
    case "instagram":
      return { width: 1080, height: 1080 };
    case "twitter":
    case "linkedin":
    case "facebook":
    default:
      return { width: 1200, height: 675 };
  }
}

export function generateNewsCardHtml(options: NewsCardOptions): string {
  const { width, height } = getDimensions(options.platform);
  const gradientFrom = options.gradientFrom || "#1a1a2e";
  const gradientTo = options.gradientTo || "#16213e";
  const accentColor = options.accentColor || "#e94560";
  const date = options.date || new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  // Auto-size headline font based on length
  let headlineFontSize = 52;
  if (options.headline.length > 100) headlineFontSize = 36;
  else if (options.headline.length > 70) headlineFontSize = 42;
  else if (options.headline.length > 40) headlineFontSize = 48;

  const logoHtml = options.logoUrl
    ? `<img src="${options.logoUrl}" style="width: 48px; height: 48px; border-radius: 8px; object-fit: contain;" />`
    : "";

  const handleHtml = options.handle
    ? `<span style="color: rgba(255,255,255,0.7); font-size: 18px;">${options.handle}</span>`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${width}px;
    height: ${height}px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(135deg, ${gradientFrom}, ${gradientTo});
    color: white;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 60px;
    overflow: hidden;
  }
  .top-bar {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .news-badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: ${accentColor};
    padding: 8px 20px;
    border-radius: 24px;
    font-size: 16px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
  }
  .headline {
    font-size: ${headlineFontSize}px;
    font-weight: 800;
    line-height: 1.2;
    letter-spacing: -0.5px;
    text-shadow: 0 2px 20px rgba(0,0,0,0.3);
  }
  .bottom-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .source-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .source-name {
    font-size: 20px;
    font-weight: 600;
    color: rgba(255,255,255,0.9);
  }
  .date-text {
    font-size: 16px;
    color: rgba(255,255,255,0.6);
  }
  .branding {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .divider {
    width: 60px;
    height: 4px;
    background: ${accentColor};
    border-radius: 2px;
  }
</style>
</head>
<body>
  <div>
    <div class="top-bar">
      ${logoHtml}
      <div class="news-badge">📰 Trending News</div>
    </div>
  </div>

  <div>
    <div class="divider" style="margin-bottom: 24px;"></div>
    <div class="headline">${escapeHtml(options.headline)}</div>
  </div>

  <div class="bottom-bar">
    <div class="source-info">
      <div class="source-name">Source: ${escapeHtml(options.source)}</div>
      <div class="date-text">${date}</div>
    </div>
    <div class="branding">
      ${handleHtml}
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/ai/src/tools/news-card-template.ts
git commit -m "feat: add news card HTML template for image generation"
```

---

### Task 4: Create news image generator (Puppeteer + DALL-E)

**Files:**
- Create: `packages/ai/src/tools/news-image-generator.ts`
- Modify: `packages/ai/package.json`

- [ ] **Step 1: Add puppeteer dependency**

```bash
cd /Users/sudhanshu6454/Posting\ Automation && pnpm --filter @postautomation/ai add puppeteer
```

- [ ] **Step 2: Create the image generator**

```typescript
// packages/ai/src/tools/news-image-generator.ts

import puppeteer from "puppeteer";
import { generateNewsCardHtml, type NewsCardOptions } from "./news-card-template";
import { generateImageDallE } from "../providers/dalle.provider";

export interface NewsImageResult {
  imageBase64: string;
  mimeType: string;
  width: number;
  height: number;
  style: "news_card" | "ai_generated";
}

/**
 * Generate a news card image from HTML template.
 * Renders the template to PNG using Puppeteer.
 */
export async function generateNewsCardImage(
  options: NewsCardOptions
): Promise<NewsImageResult> {
  const html = generateNewsCardHtml(options);

  const dimensions = options.platform === "instagram"
    ? { width: 1080, height: 1080 }
    : { width: 1200, height: 675 };

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport(dimensions);
    await page.setContent(html, { waitUntil: "networkidle0" });

    const screenshotBuffer = await page.screenshot({
      type: "png",
      encoding: "base64",
    });

    return {
      imageBase64: screenshotBuffer as string,
      mimeType: "image/png",
      width: dimensions.width,
      height: dimensions.height,
      style: "news_card",
    };
  } finally {
    await browser.close();
  }
}

/**
 * Generate an AI image for a news article using DALL-E.
 */
export async function generateNewsAiImage(
  headline: string,
  source: string
): Promise<NewsImageResult> {
  const prompt = `Create a professional, visually striking editorial illustration for a news article titled: "${headline}". Modern, clean, digital art style suitable for social media. No text in the image.`;

  const result = await generateImageDallE({
    prompt,
    size: "1024x1024",
    quality: "standard",
  });

  return {
    imageBase64: result.imageBase64,
    mimeType: result.mimeType,
    width: 1024,
    height: 1024,
    style: "ai_generated",
  };
}

/**
 * Generate a news image — dispatches to card or AI based on style parameter.
 */
export async function generateNewsImage(
  style: "news_card" | "ai_generated",
  options: {
    headline: string;
    source: string;
    sourceUrl?: string;
    logoUrl?: string;
    handle?: string;
    platform: "instagram" | "twitter" | "linkedin" | "facebook";
  }
): Promise<NewsImageResult> {
  if (style === "ai_generated") {
    return generateNewsAiImage(options.headline, options.source);
  }

  return generateNewsCardImage({
    headline: options.headline,
    source: options.source,
    sourceUrl: options.sourceUrl,
    logoUrl: options.logoUrl,
    handle: options.handle,
    platform: options.platform,
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/ai/src/tools/news-image-generator.ts packages/ai/package.json pnpm-lock.yaml
git commit -m "feat: add news image generator with Puppeteer card and DALL-E support"
```

---

## Chunk 3: AI Chain + Prompt Updates

### Task 5: Update chat agent types and context

**Files:**
- Modify: `packages/ai/src/chains/chat-agent.chain.ts:12-20`

- [ ] **Step 1: Extend ChatContext interface**

In `packages/ai/src/chains/chat-agent.chain.ts`, update the `ChatContext` interface (line 12-15) to add optional trending news and org info:

```typescript
export interface ChatContext {
  channels: Array<{ id: string; name: string; platform: string }>;
  agents: Array<{ id: string; name: string; niche: string; isActive: boolean }>;
  trendingNews?: Array<{
    title: string;
    source: string;
    link: string;
    summary: string;
  }>;
  orgLogo?: string;  // URL to org logo for news card images
  orgName?: string;  // Org name for branding
}
```

- [ ] **Step 2: Extend ChatAgentAction type**

Update the `ChatAgentAction` interface (line 17-20) to include the new action type:

```typescript
export interface ChatAgentAction {
  type: "create_agent" | "generate_content" | "schedule_post" | "update_agent" | "generate_news_image";
  payload: Record<string, unknown>;
}
```

- [ ] **Step 3: Update buildContextString to include trending news**

Add trending news section to `buildContextString` function (after line 65, before the return):

```typescript
  if (context.trendingNews && context.trendingNews.length > 0) {
    parts.push("\n## Trending News (fetched just now — present these to the user)");
    context.trendingNews.forEach((article, i) => {
      parts.push(`  ${i + 1}. "${article.title}" — ${article.source}`);
      parts.push(`     Link: ${article.link}`);
      if (article.summary) {
        parts.push(`     Summary: ${article.summary.slice(0, 200)}`);
      }
    });
    parts.push("\nBased on these headlines, present the top stories and draft a social media post from the most relevant one. Include a generate_news_image action block.");
  }

  if (context.orgLogo) {
    parts.push(`\nOrganization logo URL: ${context.orgLogo}`);
  }
  if (context.orgName) {
    parts.push(`Organization name: ${context.orgName}`);
  }
```

- [ ] **Step 4: Commit**

```bash
git add packages/ai/src/chains/chat-agent.chain.ts
git commit -m "feat: extend ChatContext with trending news, org logo, and news image action type"
```

---

### Task 6: Update system prompt

**Files:**
- Modify: `packages/ai/src/prompts/chat-agent.prompt.ts`

- [ ] **Step 1: Add trending news capability and image action to the prompt**

In `packages/ai/src/prompts/chat-agent.prompt.ts`, update the system prompt:

**Add capability #5 after line 8** (after "Edit & Refine"):

```
5. **Trending News** - When provided with trending headlines in context, present the top 5 articles as a numbered list, then auto-generate a social media post from the most relevant article
6. **News Images** - Generate branded news card images or AI-generated images to accompany news posts
```

**Add action type to the Action Format section** (update line 14):

```
  "type": "create_agent" | "generate_content" | "schedule_post" | "update_agent" | "generate_news_image",
```

**Add generate_news_image payload section** (after the schedule_post payload, before Guidelines):

```
**generate_news_image:**
\`\`\`json
{
  "type": "generate_news_image",
  "payload": {
    "headline": "The article headline",
    "source": "Source name",
    "sourceUrl": "https://source-url",
    "imageStyle": "news_card",
    "includeLogo": true,
    "platform": "INSTAGRAM",
    "content": "The accompanying post text with hashtags"
  }
}
\`\`\`
imageStyle can be "news_card" (branded template, default for factual news) or "ai_generated" (DALL-E image, for creative topics).
```

**Add to Guidelines section** (after existing guidelines):

```
- When trending news headlines are provided in context, ALWAYS present them as a numbered list first, then draft a post from the most relevant one
- After generating a news post draft, ALWAYS ask the user: 1) which platform(s) to post to (list their connected channels), 2) post now or schedule, 3) confirm logo on image (default yes if org logo exists)
- Only emit schedule_post action AFTER user confirms platform and timing
- Include generate_news_image action with the post draft so the image is generated alongside the text
- Default to news_card style for breaking/factual news, ai_generated for creative/lifestyle topics
```

- [ ] **Step 2: Commit**

```bash
git add packages/ai/src/prompts/chat-agent.prompt.ts
git commit -m "feat: update system prompt with trending news, news image, and posting flow"
```

---

### Task 7: Export new functions from AI package

**Files:**
- Modify: `packages/ai/src/index.ts`

- [ ] **Step 1: Add exports**

Append to `packages/ai/src/index.ts`:

```typescript
export { fetchTrendingNews, detectTrendingIntent } from "./tools/trending-news";
export type { TrendingHeadline } from "./tools/trending-news";
export { generateNewsCardImage, generateNewsAiImage, generateNewsImage } from "./tools/news-image-generator";
export type { NewsImageResult } from "./tools/news-image-generator";
export { generateNewsCardHtml } from "./tools/news-card-template";
export type { NewsCardOptions } from "./tools/news-card-template";
export { parseRssItems } from "./utils/rss-parser";
export type { RssItem } from "./utils/rss-parser";
```

- [ ] **Step 2: Commit**

```bash
git add packages/ai/src/index.ts
git commit -m "feat: export trending news and image generation from @postautomation/ai"
```

---

## Chunk 4: Streaming Route + Backend Action Handler

### Task 8: Update streaming route with trending news detection

**Files:**
- Modify: `apps/web/app/api/chat/stream/route.ts`

- [ ] **Step 1: Add trending news detection and context enrichment**

Update `apps/web/app/api/chat/stream/route.ts`. Add import at top:

```typescript
import { streamChatAgent, parseActions, cleanResponseText, fetchTrendingNews, detectTrendingIntent } from "@postautomation/ai";
```

After the `[channels, agents]` parallel query (line 63-73), add org data loading and trending news detection:

```typescript
  // Load org info for branding
  const org = await prisma.organization.findUnique({
    where: { id: membership.organizationId },
    select: { name: true, logo: true },
  });

  // Detect trending news intent from the last user message
  const lastUserMessage = messages.filter((m) => m.role === "user").pop();
  let trendingNews: Array<{ title: string; source: string; link: string; summary: string }> | undefined;

  if (lastUserMessage) {
    const trendingIntent = detectTrendingIntent(lastUserMessage.content);
    if (trendingIntent) {
      try {
        const topic = typeof trendingIntent === "string" ? trendingIntent : undefined;
        const headlines = await fetchTrendingNews(topic, 10);
        trendingNews = headlines.map((h) => ({
          title: h.title,
          source: h.source,
          link: h.link,
          summary: h.summary,
        }));
      } catch (error) {
        console.error("[Chat] Failed to fetch trending news:", error);
        // Continue without news — AI will respond normally
      }
    }
  }
```

Update the `streamChatAgent` call (line 87-94) to pass enriched context:

```typescript
      for await (const chunk of streamChatAgent(provider, messages, {
        channels: channels.map((ch) => ({
          id: ch.id,
          name: ch.name || ch.username || "Unknown",
          platform: ch.platform,
        })),
        agents,
        trendingNews,
        orgLogo: org?.logo || undefined,
        orgName: org?.name || undefined,
      })) {
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/api/chat/stream/route.ts
git commit -m "feat: detect trending intent and fetch Google News in streaming route"
```

---

### Task 9: Handle generate_news_image action in chat router

**Files:**
- Modify: `packages/api/src/routers/chat.router.ts`

- [ ] **Step 1: Update executeAction to accept generate_news_image**

In `packages/api/src/routers/chat.router.ts`, update the `actionType` enum (line 156):

```typescript
actionType: z.enum(["create_agent", "generate_content", "schedule_post", "update_agent", "generate_news_image"]),
```

Add the new case in the switch statement (before the `default` case, after `update_agent`):

```typescript
        case "generate_news_image": {
          const p = input.payload as any;

          // Dynamically import to avoid loading puppeteer eagerly
          const { generateNewsImage } = await import("@postautomation/ai");

          const style = p.imageStyle === "ai_generated" ? "ai_generated" : "news_card";
          const platform = (p.platform || "twitter").toLowerCase() as "instagram" | "twitter" | "linkedin" | "facebook";

          // Get org logo if includeLogo is true and not explicitly provided
          let logoUrl = p.logoUrl;
          if (p.includeLogo !== false && !logoUrl) {
            const org = await ctx.prisma.organization.findUnique({
              where: { id: ctx.organizationId },
              select: { logo: true },
            });
            logoUrl = org?.logo || undefined;
          }

          const imageResult = await generateNewsImage(style, {
            headline: p.headline || "Trending News",
            source: p.source || "News",
            sourceUrl: p.sourceUrl,
            logoUrl,
            platform,
          });

          // Save image as Media
          const imageBuffer = Buffer.from(imageResult.imageBase64, "base64");
          const fileName = `news-${Date.now()}.png`;

          // Store via creating a Media record with base64 data URL
          // (In production, upload to S3/MinIO first — for now, use data URL)
          const dataUrl = `data:${imageResult.mimeType};base64,${imageResult.imageBase64}`;

          const media = await ctx.prisma.media.create({
            data: {
              organizationId: ctx.organizationId,
              uploadedById: (ctx.session.user as any).id,
              fileName,
              fileType: imageResult.mimeType,
              fileSize: imageBuffer.length,
              url: dataUrl,
              width: imageResult.width,
              height: imageResult.height,
            },
          });

          // Attach to a system message in the thread
          await ctx.prisma.chatMessage.create({
            data: {
              threadId: input.threadId,
              role: "system",
              content: `News image generated (${style === "news_card" ? "branded card" : "AI illustration"}).`,
              metadata: {
                type: "news_image_generated",
                mediaId: media.id,
                style,
                headline: p.headline,
              },
              attachments: {
                create: { mediaId: media.id },
              },
            },
          });

          return {
            type: "news_image_generated",
            mediaId: media.id,
            imageUrl: dataUrl,
            style,
            content: p.content,
          };
        }
```

- [ ] **Step 2: Commit**

```bash
git add packages/api/src/routers/chat.router.ts
git commit -m "feat: handle generate_news_image action in chat router"
```

---

## Chunk 5: Frontend — Display News Image in Chat

### Task 10: Update MessageBubble to render news images

**Files:**
- Modify: `apps/web/components/chat/MessageBubble.tsx`

- [ ] **Step 1: Add news image rendering and generate image button**

In `apps/web/components/chat/MessageBubble.tsx`, add the `ImageIcon` import (line 3):

```typescript
import { Bot, User, Info, ImageIcon } from "lucide-react";
```

Add news image action detection after `isContentDraft` (after line 37):

```typescript
  const isNewsImage = action?.type === "generate_news_image";
```

Add the news image UI block after the agent creation confirmation block (after line 111, before the closing `</div>`):

```typescript
        {/* News image generation */}
        {!isUser && isNewsImage && action?.payload && (
          <div className="mt-3 border-t pt-3 space-y-3">
            <button
              onClick={() => onExecuteAction?.(action)}
              disabled={isExecuting}
              className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-rose-500 to-orange-500 px-4 py-2 text-sm font-medium text-white transition-all hover:from-rose-600 hover:to-orange-600 disabled:opacity-50"
            >
              <ImageIcon className="h-4 w-4" />
              {isExecuting ? "Generating image..." : "🖼️ Generate News Image"}
            </button>
            {action.payload.content && (
              <p className="text-xs text-muted-foreground">
                Platform: {(action.payload.platform as string) || "Not specified"} •
                Style: {(action.payload.imageStyle as string) === "ai_generated" ? "AI Generated" : "News Card"}
              </p>
            )}
          </div>
        )}

        {/* Display attached news image (after generation) */}
        {message.metadata?.type === "news_image_generated" && message.attachments?.[0] && (
          <div className="mt-3">
            <img
              src={message.attachments[0].media.url}
              alt={message.metadata.headline || "News image"}
              className="rounded-lg max-w-full"
              style={{ maxHeight: 400 }}
            />
          </div>
        )}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/components/chat/MessageBubble.tsx
git commit -m "feat: render news image button and inline image in chat bubbles"
```

---

### Task 11: Build and verify

**Files:** None (verification only)

- [ ] **Step 1: Run TypeScript build**

```bash
cd /Users/sudhanshu6454/Posting\ Automation && pnpm build
```

Expected: No TypeScript errors across all packages.

- [ ] **Step 2: Fix any build errors**

If any type errors arise, fix them. Common issues:
- Import paths (ensure `@postautomation/ai` exports are correct)
- Puppeteer types (may need `@types/puppeteer` or use the bundled types)
- Prisma type for `metadata` field (use `JSON.parse(JSON.stringify(...))` if needed)

- [ ] **Step 3: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: resolve build errors for trending news feature"
```

---

## Chunk 6: Deploy

### Task 12: Deploy to production

- [ ] **Step 1: Push to main**

```bash
cd /Users/sudhanshu6454/Posting\ Automation && git push origin main
```

- [ ] **Step 2: Deploy on server**

```bash
ssh deploy@172.236.181.160
cd /home/deploy/postautomation
git pull origin main
docker compose -f docker-compose.prod.yml build web worker
docker compose -f docker-compose.prod.yml up -d web worker
```

Note: Puppeteer needs Chromium inside the Docker container. If the web container doesn't have Chromium, the Dockerfile needs updating to install it:

```dockerfile
# Add to web Dockerfile before the build step
RUN apt-get update && apt-get install -y chromium --no-install-recommends && rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

- [ ] **Step 3: Verify containers are running**

```bash
docker compose -f docker-compose.prod.yml ps
```

Expected: web and worker containers UP and healthy.
